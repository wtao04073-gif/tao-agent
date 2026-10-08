import type { Values } from './admin-settings.ts';
import { AdminError } from './admin-settings.ts';
import { checkEndpoint } from './admin-integrations.ts';
import type { ModelEndpoint } from '@tao/agent-host';
export const EXTRA_MODELS=[['model-a','MODEL_A'],['model-b','MODEL_B'],['model-c','MODEL_C'],['vision','VISION_MODEL']] as const;
export function modelProfiles(v:Values){
 return [['flagship','MODEL'],['lite','MODEL_LITE'],...EXTRA_MODELS].map(([id,prefix])=>({id:id!,name:v[prefix+'_LABEL']||v[prefix+'_NAME']||id!,vision:v[prefix+'_VISION']==='true'||id==='vision',available:!!(v[prefix+'_NAME']&&v[prefix+'_BASE_URL']&&v[prefix+'_API_KEY'])}));
}
export function extraModelEndpoints(v:Values):Record<string,ModelEndpoint>{const result:Record<string,ModelEndpoint>={};for(const [id,p] of EXTRA_MODELS){if(!v[p+'_NAME']&&!v[p+'_BASE_URL']&&!v[p+'_API_KEY'])continue;if(!v[p+'_NAME']||!v[p+'_BASE_URL']||!v[p+'_API_KEY'])throw new AdminError(400,p+' 地址、名称和密钥需完整填写（Ollama 密钥可填 ollama）');checkEndpoint(v[p+'_BASE_URL']!);result[id]={baseUrl:v[p+'_BASE_URL']!,apiKey:v[p+'_API_KEY']!,modelName:v[p+'_NAME']!,vision:id==='vision'||v[p+'_VISION']==='true',maxTokens:Number(v.MODEL_MAX_TOKENS||4096),contextWindow:Number(v[p+'_CONTEXT_WINDOW']||32768),inputCostPerMillion:Number(v[p+'_INPUT_PRICE']||0),outputCostPerMillion:Number(v[p+'_OUTPUT_PRICE']||0)};}return result;}
