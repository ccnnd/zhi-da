# PipelineRunner 状态驱动执行器——按序执行 PipelineStep 列表，支持进度回调、RunLogger 和异常降级
# 支持并行步骤组：将多个步骤放入 list 中传入 stages，它们会通过 asyncio.gather 并发执行
import asyncio
import logging
import time
from typing import Callable, Union
from .step import PipelineStep, PipelineState
from .logger import RunLogger

logger = logging.getLogger(__name__)

# 单个步骤或一组并行步骤
Stage = Union[PipelineStep, list[PipelineStep]]


# Pipeline 运行引擎
class PipelineRunner:
    def __init__(self, steps: list[PipelineStep], fallback_handler: Callable = None):
        self.steps = steps
        self.fallback_handler = fallback_handler
        self.run_logger = RunLogger()

    async def run(self, state: PipelineState, on_progress: Callable = None) -> PipelineState:
        """按序执行 steps 列表（保持向后兼容）。"""
        state.metadata["pipeline_start"] = time.time()
        total = len(self.steps)
        failed_steps: set[str] = set()

        for i, step in enumerate(self.steps):
            skipped_due_to_dep = [dep for dep in step.depends_on if dep in failed_steps]
            if skipped_due_to_dep:
                logger.info("Pipeline step '%s' 跳过：依赖步骤 %s 已失败", step.name, skipped_due_to_dep)
                state.add_error(f"{step.name}: 跳过（依赖步骤 {', '.join(skipped_due_to_dep)} 失败）")
                state.metadata[f"{step.name}_skipped"] = True
                self.run_logger.log(
                    step_name=step.name,
                    error=f"skipped: dep {skipped_due_to_dep} failed",
                )
                continue

            step_start = time.time()
            error_msg = ""
            try:
                if on_progress:
                    await on_progress(step.name, (i + 1) / total, f"正在执行: {step.name}")
                state = await step.execute(state)
                duration_ms = (time.time() - step_start) * 1000
                state.metadata[f"{step.name}_duration"] = duration_ms
                token_usage = state.metadata.get(f"{step.name}_tokens", {})
                self.run_logger.log(
                    step_name=step.name,
                    input_summary=str(state.input.get(step.name, ""))[:200],
                    output_summary=str(state.results.get(step.name, ""))[:200],
                    duration_ms=round(duration_ms, 2),
                    token_usage=token_usage if isinstance(token_usage, dict) else {},
                )
            except Exception as e:
                duration_ms = (time.time() - step_start) * 1000
                error_msg = str(e)
                err_type = type(e).__name__
                logger.error(f"Pipeline step '{step.name}' failed ({err_type}): {e}", exc_info=True)
                failed_steps.add(step.name)
                state.add_error(f"{step.name}: [{err_type}] {str(e)}")
                self.run_logger.log(
                    step_name=step.name,
                    duration_ms=round(duration_ms, 2),
                    error=f"[{err_type}] {error_msg}",
                )
                if self.fallback_handler:
                    await self.fallback_handler(step.name, state, e)
                else:
                    break
            if state.has_errors() and not self.fallback_handler:
                break
        state.metadata["pipeline_duration"] = time.time() - state.metadata["pipeline_start"]
        state.metadata["run_log"] = self.run_logger.to_dict()
        state.metadata["run_log_summary"] = self.run_logger.summary()
        return state

    async def run_stages(self, stages: list[Stage], state: PipelineState, on_progress: Callable = None) -> PipelineState:
        """执行分阶段流水线，支持单步骤和并行步骤组。

        stages 中的每个元素可以是：
        - PipelineStep: 单步串行执行
        - list[PipelineStep]: 多个步骤通过 asyncio.gather 并行执行

        进度回调按阶段总数计算百分比。
        """
        state.metadata["pipeline_start"] = time.time()
        total = len(stages)
        failed_steps: set[str] = set()

        for i, stage in enumerate(stages):
            parallel_steps = stage if isinstance(stage, list) else [stage]

            # 依赖检查：并行组中每个步骤都检查前置依赖
            runnable: list[PipelineStep] = []
            for step in parallel_steps:
                skipped_deps = [dep for dep in step.depends_on if dep in failed_steps]
                if skipped_deps:
                    logger.info("Pipeline step '%s' 跳过：依赖步骤 %s 已失败", step.name, skipped_deps)
                    state.add_error(f"{step.name}: 跳过（依赖步骤 {', '.join(skipped_deps)} 失败）")
                    state.metadata[f"{step.name}_skipped"] = True
                    self.run_logger.log(step_name=step.name, error=f"skipped: dep {skipped_deps} failed")
                else:
                    runnable.append(step)

            if not runnable:
                continue

            # 进度回调：报告当前阶段
            if on_progress:
                names = ", ".join(s.name for s in runnable)
                await on_progress(names, (i + 1) / total, f"正在执行: {names}")

            if len(runnable) == 1:
                # 单步骤走原来的串行逻辑
                step = runnable[0]
                step_start = time.time()
                try:
                    state = await step.execute(state)
                    duration_ms = (time.time() - step_start) * 1000
                    state.metadata[f"{step.name}_duration"] = duration_ms
                    token_usage = state.metadata.get(f"{step.name}_tokens", {})
                    self.run_logger.log(
                        step_name=step.name,
                        input_summary=str(state.input.get(step.name, ""))[:200],
                        output_summary=str(state.results.get(step.name, ""))[:200],
                        duration_ms=round(duration_ms, 2),
                        token_usage=token_usage if isinstance(token_usage, dict) else {},
                    )
                except Exception as e:
                    duration_ms = (time.time() - step_start) * 1000
                    err_type = type(e).__name__
                    logger.error(f"Pipeline step '{step.name}' failed ({err_type}): {e}", exc_info=True)
                    failed_steps.add(step.name)
                    state.add_error(f"{step.name}: [{err_type}] {str(e)}")
                    self.run_logger.log(step_name=step.name, duration_ms=round(duration_ms, 2), error=f"[{err_type}] {e}")
                    if self.fallback_handler:
                        await self.fallback_handler(step.name, state, e)
                    else:
                        break
            else:
                # 并行执行多个步骤
                async def _run_one(step: PipelineStep):
                    step_start = time.time()
                    try:
                        new_state = await step.execute(state)
                        duration_ms = (time.time() - step_start) * 1000
                        return step, new_state, duration_ms, None
                    except Exception as e:
                        duration_ms = (time.time() - step_start) * 1000
                        return step, None, duration_ms, e

                results = await asyncio.gather(*[_run_one(s) for s in runnable])

                for step, new_state, duration_ms, error in results:
                    state.metadata[f"{step.name}_duration"] = duration_ms
                    if error is not None:
                        err_type = type(error).__name__
                        logger.error(f"Pipeline step '{step.name}' failed ({err_type}): {error}", exc_info=True)
                        failed_steps.add(step.name)
                        state.add_error(f"{step.name}: [{err_type}] {error}")
                        self.run_logger.log(step_name=step.name, duration_ms=round(duration_ms, 2), error=f"[{err_type}] {error}")
                        if self.fallback_handler:
                            await self.fallback_handler(step.name, state, error)
                    else:
                        # 合并并行步骤产出的 results 到共享 state
                        if new_state:
                            state.results.update(new_state.results)
                            # 合并 metadata（token 用量等）
                            for k, v in new_state.metadata.items():
                                if k not in state.metadata:
                                    state.metadata[k] = v
                        token_usage = state.metadata.get(f"{step.name}_tokens", {})
                        self.run_logger.log(
                            step_name=step.name,
                            input_summary=str(state.input.get(step.name, ""))[:200],
                            output_summary=str(state.results.get(step.name, ""))[:200],
                            duration_ms=round(duration_ms, 2),
                            token_usage=token_usage if isinstance(token_usage, dict) else {},
                        )

            if state.has_errors() and not self.fallback_handler:
                break

        state.metadata["pipeline_duration"] = time.time() - state.metadata["pipeline_start"]
        state.metadata["run_log"] = self.run_logger.to_dict()
        state.metadata["run_log_summary"] = self.run_logger.summary()
        return state

    def get_run_logger(self) -> RunLogger:
        return self.run_logger
