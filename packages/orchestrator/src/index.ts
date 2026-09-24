/**
 * @tao/orchestrator —— 任务编排
 *
 * 不接触 vendor/pi：只依赖 @tao/core 的 RunnerFactory 接口，
 * 具体 Runner 实现由调用方注入。
 */

export {
	TaskOrchestrator,
	IllegalTransition,
	type TaskRecord,
	type SubmitOptions,
} from "./task-orchestrator.ts";
