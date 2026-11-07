import { randomUUID } from 'node:crypto';
import type { AuthEvent, AuthPrompt, AuthType, LoginOptions, Models } from '@earendil-works/pi-ai';
import { AppError } from './domain.js';

export type AuthJobState = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type AuthJobView = {
  id: string; providerId: string; type: AuthType; state: AuthJobState;
  event?: AuthEvent; events: { sequence: number; event: AuthEvent }[]; eventCursor: number; prompt?: Omit<AuthPrompt, 'signal'>; promptId?: string;
};
type PendingPrompt = { id: string; resolve: (value: string) => void; reject: (error: unknown) => void; dispose: () => void };
type Job = { view: AuthJobView; controller: AbortController; pending?: PendingPrompt;completion?:Promise<void> };

/** Orchestrates provider-owned login. Credential storage is owned by the supplied Models. */
export class AuthService {
  private readonly jobs = new Map<string, Job>();
  private closing = false;
  constructor(private readonly models: Models, private readonly loginOptions?: LoginOptions) {}

  providers() {
    return this.models.getProviders().map(provider => ({
      id: provider.id, name: provider.name,
      methods: [
        ...(provider.auth.apiKey?.login ? [{ type: 'api_key' as const, name: provider.auth.apiKey.name }] : []),
        ...(provider.auth.oauth ? [{ type: 'oauth' as const, name: provider.auth.oauth.name }] : []),
      ],
    }));
  }

  async status(providerId: string) {
    if (!this.models.getProvider(providerId)) throw new AppError('auth_provider_not_found', 404);
    const auth = await this.models.checkAuth(providerId);
    return { providerId, configured: Boolean(auth), ...(auth ? { type: auth.type, source: auth.source } : {}) };
  }

  start(providerId: string, type: AuthType): AuthJobView {
    if (this.closing) throw new AppError('auth_service_closed', 409);
    const provider = this.models.getProvider(providerId);
    if (!provider) throw new AppError('auth_provider_not_found', 404);
    if (type !== 'api_key' && type !== 'oauth') throw new AppError('invalid_auth_method');
    if (!(type === 'oauth' ? provider.auth.oauth?.login : provider.auth.apiKey?.login)) throw new AppError('auth_method_not_supported');
    const id = randomUUID();
    const job: Job = { view: { id, providerId, type, state: 'running', events: [], eventCursor: 0 }, controller: new AbortController() };
    this.jobs.set(id, job);
    job.completion=this.models.login(providerId, type, {
      signal: job.controller.signal,
      notify: event => {
        if (job.view.state !== 'running') return;
        const visible = visibleEvent(event);
        job.view.event = visible;
        job.view.events.push({ sequence: ++job.view.eventCursor, event: visible });
      },
      prompt: prompt => this.prompt(job, prompt),
    }, this.loginOptions).then(() => {
      job.view.state = 'completed';
    }, () => {
      job.view.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
    }).finally(() => {
      job.pending?.reject(new Error('Login ended'));
      job.pending?.dispose(); job.pending = undefined;
      delete job.view.prompt; delete job.view.promptId; delete job.view.event; job.view.events = [];
    });
    return this.view(job);
  }

  get(id: string): AuthJobView { return this.view(this.job(id)); }

  respond(id: string, value: string, promptId: string): AuthJobView {
    const job = this.job(id);
    if (job.view.state !== 'running' || !job.pending || typeof promptId !== 'string' || promptId !== job.pending.id) throw new AppError('auth_prompt_not_pending', 409);
    if (typeof value !== 'string' || value.length > 64_000) throw new AppError('invalid_auth_response');
    const pending = job.pending; job.pending = undefined; delete job.view.prompt; delete job.view.promptId;
    pending.dispose(); pending.resolve(value);
    return this.view(job);
  }

  cancel(id: string): AuthJobView {
    const job = this.job(id);
    if (job.view.state === 'running') {
      job.view.state = 'cancelling'; job.controller.abort();
      job.pending?.reject(new Error('Login cancelled')); job.pending?.dispose(); job.pending = undefined;
      delete job.view.prompt; delete job.view.promptId; delete job.view.event; job.view.events = [];
    }
    return this.view(job);
  }

  async close(){
    this.closing = true;
    for(const [id,job] of this.jobs)if(job.view.state==='running')this.cancel(id);
    await Promise.allSettled([...this.jobs.values()].map(job=>job.completion).filter((value):value is Promise<void>=>Boolean(value)));
  }
  private job(id: string): Job {
    const job = this.jobs.get(id); if (!job) throw new AppError('auth_job_not_found', 404); return job;
  }
  private view(job: Job): AuthJobView { return structuredClone(job.view); }
  private prompt(job: Job, prompt: AuthPrompt): Promise<string> {
    if (job.view.state !== 'running' || job.controller.signal.aborted || prompt.signal?.aborted) return Promise.reject(new Error('Login cancelled'));
    if (job.pending) return Promise.reject(new Error('Concurrent auth prompts are unsupported'));
    const { signal, ...visible } = prompt;
    const id = randomUUID();
    job.view.prompt = structuredClone(visible); job.view.promptId = id;
    return new Promise((resolve, reject) => {
      const abort = () => { if (job.pending) { job.pending.dispose(); job.pending = undefined; delete job.view.prompt; delete job.view.promptId; reject(new Error('Prompt cancelled')); } };
      const dispose = () => { signal?.removeEventListener('abort', abort); job.controller.signal.removeEventListener('abort', abort); };
      job.pending = { id, resolve, reject, dispose };
      signal?.addEventListener('abort', abort, { once: true });
      job.controller.signal.addEventListener('abort', abort, { once: true });
    });
  }
}

// Only the public Pi interaction fields belong in a job view, never credentials.
function visibleEvent(event: AuthEvent): AuthEvent {
  switch (event.type) {
    case 'auth_url': return { type: event.type, url: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) };
    case 'device_code': return { type: event.type, userCode: event.userCode, verificationUri: event.verificationUri,
      ...(event.openBrowserOnConfirm === undefined ? {} : { openBrowserOnConfirm: event.openBrowserOnConfirm }),
      ...(event.copyCodeOnConfirm === undefined ? {} : { copyCodeOnConfirm: event.copyCodeOnConfirm }),
      ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
      ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }) };
    case 'info': return { type: event.type, message: event.message, ...(event.links === undefined ? {} : { links: event.links.map(link => ({ url: link.url, ...(link.label === undefined ? {} : { label: link.label }) })) }) };
    case 'progress': return { type: event.type, message: event.message };
  }
}
