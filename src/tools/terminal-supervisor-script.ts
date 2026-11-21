/*
Derived from Hermes 0.23.1 hermes_cli/process_supervisor.sh.
https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/hermes_cli/process_supervisor.sh
Adaptation adds readiness acknowledgements and records an unknown result after owner loss.

MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
export const terminalSupervisorScript="#!/bin/sh\n# Hermes process supervisor: one per Hermes process, reaping the process groups it owns once it dies.\n#\n# Usage: sh process_supervisor.sh <parent-pgid>, spawned with start_new_session=True and stdin a\n# pipe whose only write end Hermes holds (hermes_cli/process_identity.py, \"owner-death supervisor\").\n# stdin carries one command per line:\n#     register <pgid>     reap this process group when Hermes dies\n#     unregister <pgid>   stop reaping it (Hermes stopped that child itself)\n# EOF means Hermes is gone, by any cause including SIGKILL and the OOM killer: SIGTERM every group\n# still registered, wait up to 3 s, SIGKILL the survivors, exit. A clean exit is the same EOF, so a\n# child Hermes never unregistered dies with it either way.\n#\n# POSIX sh, not Python: Hermes keeps this process resident for its whole life, and an idle sh costs\n# about 0.5 MB USS where an idle interpreter costs about 8 MB. It must also never import Hermes:\n# it runs after Hermes may already be dead.\n#\n# Malformed lines are skipped: a corrupt line must not cost the reaping guarantee for every other\n# group. Groups that are never a valid target (pgid <= 1, our own, Hermes's own) are refused at\n# registration, so a caller bug costs one unreaped child, never the Hermes process tree.\n# Residual risk: groups are reaped by number, so a registered group that exits on its own can have\n# its pgid recycled before Hermes prunes it; Hermes prunes empty groups on every registration change.\n\ntrap '\"$2\" \"$3\" \"$4\" \"$5\"' EXIT\ntrap '' INT HUP  # a dying parent's SIGINT/SIGHUP must not preempt the reap: EOF is the only signal\nparent=$1\n# Every register line compares against it: a bad value would silently refuse every registration.\ncase $parent in ''|*[!0-9]*) echo \"hermes process supervisor: bad parent pgid '$parent'; refusing to run\" >&2; exit 2 ;; esac\n# Run inside the parent's group, a killpg of the parent would take us down before we reap.\nkill -0 -$$ 2>/dev/null || {\n  echo \"hermes process supervisor: not a process-group leader; refusing to run\" >&2\n  exit 2\n}\nreg=' '\nprintf 'ready\\n'\nwhile IFS=' ' read -r verb pg rest; do\n  case $pg in ''|*[!0-9]*) continue ;; esac\n  [ -z \"$rest\" ] && [ ${#pg} -le 10 ] || continue\n  case $verb in\n    register)\n      [ \"$pg\" -gt 1 ] && [ \"$pg\" -ne $$ ] && [ \"$pg\" -ne \"$parent\" ] || continue\n      case $reg in *\" $pg \"*) ;; *) reg=\"$reg$pg \" ;; esac\n      printf \"registered %s\\n\" \"$pg\" ;;\n    unregister)\n      keep=' '\n      for g in $reg; do [ \"$g\" = \"$pg\" ] || keep=\"$keep$g \"; done\n      reg=$keep ;;\n  esac\ndone\nfor g in $reg; do kill -TERM -\"$g\" 2>/dev/null; done\nfor _ in 1 2 3; do\n  live=''\n  for g in $reg; do kill -0 -\"$g\" 2>/dev/null && live=\"$live $g\"; done\n  reg=$live\n  [ -n \"$reg\" ] || exit 0\n  # The default PATH: a broken PATH must not turn the TERM grace into an instant KILL.\n  command -p sleep 1 2>/dev/null || sleep 1\ndone\nfor g in $reg; do kill -KILL -\"$g\" 2>/dev/null; done\nexit 0\n";
