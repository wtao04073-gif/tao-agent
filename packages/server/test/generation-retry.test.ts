import { expect, it } from 'vitest';
import type { TaskEvent } from '@tao/core';
import { generationRetryContext } from '../src/generation-retry.ts';

it('只携带成功完成的工具摘要和已有回答，排除未完成及失败操作',()=>{
 const context=generationRetryContext([
  {type:'step',toolName:'local_shell',phase:'finished',resultSummary:'写入完成'},
  {type:'step',toolName:'delete_file',phase:'started',detail:'不可出现的删除'},
  {type:'step',toolName:'read_table',phase:'failed',detail:'不可出现的失败'},
  {type:'assistant_message',text:'已有回答'}
 ] as TaskEvent[]);
 expect(context).toContain('写入完成');expect(context).toContain('已有回答');expect(context).not.toContain('不可出现');expect(context).toContain('不能声称重新读取文件');
});
it('结果超限在创建任务前拒绝，按UTF8字节计数',()=>{expect(()=>generationRetryContext([{type:'assistant_message',text:'字'.repeat(40000)}] as TaskEvent[])).toThrow('已完成结果过大');});
