import {AppError} from '../domain.js';
import type {SkillResources} from './project-skills.js';
import type {ProjectResources} from './project-resources.js';

/** Named user resources and workspace resources remain separate, checked filesystem roots. */
export class ProjectSkillResources implements SkillResources {
  constructor(private readonly project:ProjectResources,private readonly user:ProjectResources){}
  private route(value:string){
    if(value==='@user'||value.startsWith('@user/'))return {source:this.user,path:value==='@user'?'.':value.slice(6),user:true};
    return {source:this.project,path:value,user:false};
  }
  private qualify(value:string,user:boolean){return user?(value==='.'?'@user':'@user/'+value.split('\\').join('/')):value;}
  skillFile(value:string){const row=this.route(value);return this.qualify(row.source.skillFile(row.path),row.user);}
  skillBase(value:string){const row=this.route(value);return this.qualify(row.source.skillBase(row.path),row.user);}
  skillName(value:string){const row=this.route(value);return row.source.skillName(row.path);}
  skillDirectories(paths:string[]){
    if(paths.some(value=>value==='@user'||value.startsWith('@user/')))throw new AppError('invalid_skill_source');
    return [...this.user.skillDirectories(['.']).map(value=>this.qualify(value,true)),...this.project.skillDirectories(paths)];
  }
  readText(value:string,maxBytes?:number){const row=this.route(value);return row.source.readText(row.path,maxBytes);}
  readBytes(value:string,maxBytes?:number){const row=this.route(value);return row.source.readBytes(row.path,maxBytes);}
  exists(value:string){const row=this.route(value);return row.source.exists(row.path);}
  stat(value:string){const row=this.route(value);return row.source.stat(row.path);}
  readFile(value:string){const row=this.route(value);return row.source.readFile(row.path);}
  readdir(value:string){const row=this.route(value);return row.source.readdir(row.path);}
  async realpath(value:string){const row=this.route(value);return this.qualify(await row.source.realpath(row.path),row.user);}
}
