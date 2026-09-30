/**
 * 修改意见回写
 *
 * **这是 M3 的验收门禁，也是整个产品最核心的差异化能力。**
 *
 * 验收标准（需求 §6）：同类任务第二次产出不再犯上次被改的错。
 *
 * 为什么这是刚需：通用 Chatbot 的结构性缺陷是「不记住本单位的口径」——
 * 用户每次都要重新解释「我们的台账要有责任人列」「金额一律保留两位小数」。
 * 改了十次还是第十一次犯同样的错，用户就放弃了。
 *
 * ── 设计的核心取舍 ──
 *
 * 用户不会写「经验条目」。他们只会**直接改产出**：把「负责人」改成「责任部门」、
 * 删掉一整段、把日期格式改掉。所以系统必须从**修改动作本身**提取经验，
 * 而不是指望用户填一个「请总结你的偏好」表单。
 *
 * 但从 diff 自动推断意图是不可靠的 —— 改了个字可能是笔误，也可能是口径纠正。
 * 所以这里的设计是**两者结合**：
 *
 *  1. 系统记录客观事实（哪个字段/章节被改了、改成什么）
 *  2. 用户可选地补一句为什么（「我们一律用责任部门」）
 *  3. 注入时把事实与理由都给模型，让它自己判断如何应用
 *
 * 刻意**不做**的事：不自动泛化（「用户改了一次日期格式」不等于「所有日期都要这样」）。
 * 过度泛化的经验比没有经验更糟 —— 它会让产出朝着用户没要求的方向漂移，
 * 而用户无法理解为什么。泛化由**重复次数**驱动：同一条被改过多次才提升权重。
 */

import type { Scope } from "./tenant.ts";

/** 修改的类型。 */
export const RevisionKind = {
	/** 措辞替换：把 A 改成 B。最常见，也最容易沉淀为口径。 */
	Wording: "wording",
	/** 结构调整：增删章节、改变栏目。 */
	Structure: "structure",
	/** 格式规范：日期格式、数字精度、字体。 */
	Format: "format",
	/** 内容删除：用户认为这段不该出现。 */
	Removal: "removal",
	/** 内容补充：用户加了原本缺失的内容。 */
	Addition: "addition",
} as const;

export type RevisionKind = (typeof RevisionKind)[keyof typeof RevisionKind];

/** 一条修改记录。由产物对比或用户标注产生。 */
export interface Revision {
	readonly kind: RevisionKind;
	/**
	 * 产物中被改的位置。
	 *
	 * 文档用标题或段落序号，表格用「工作表!单元格」或列名。
	 * 这是把经验与具体位置关联起来的钩子 —— 没有它就只能给出
	 * 「用户改过措辞」这种无法应用的模糊经验。
	 */
	readonly target: string;
	/** 改之前的内容。 */
	readonly before: string;
	/** 改之后的内容。 */
	readonly after: string;
	/** 用户补充的原因。可选 —— 大多数人不会填。 */
	readonly reason?: string;
}

/**
 * 一条沉淀下来的经验。
 *
 * 与 Revision 的区别：Revision 是一次具体修改，Lesson 是跨任务复用的规则。
 */
export interface Lesson {
	readonly id: string;
	readonly tenantId: string;
	/** 适用的场景卡。经验按场景隔离 —— 台账的口径不该影响 8D 报告。 */
	readonly scenarioId: string;
	readonly kind: RevisionKind;
	/** 面向模型的规则描述。 */
	readonly rule: string;
	/** 该经验来自哪些修改。保留证据，便于用户理解「系统为什么这么做」。 */
	readonly evidence: readonly Revision[];
	/**
	 * 被印证的次数。
	 *
	 * 同一条经验被反复触发时权重提升。这是泛化的唯一驱动力 ——
	 * 改一次是偶然，改三次就是口径。
	 */
	readonly timesObserved: number;
	readonly scope: Scope;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** 经验的存储接口。与知识库一样抽成接口，便于换持久化实现。 */
export interface LessonStore {
	/** 取某租户某场景的经验，按权重降序。 */
	list(tenantId: string, scenarioId: string): Promise<Lesson[]>;
	/** 新增或合并一条经验。 */
	upsert(lesson: Lesson): Promise<Lesson>;
	/** 按 id 取。 */
	get(tenantId: string, id: string): Promise<Lesson | undefined>;
	/** 删除。用户可以否决一条被错误沉淀的经验。 */
	remove(tenantId: string, id: string): Promise<boolean>;
}

/** 规范化文本用于比较：去首尾空白、统一全角半角。 */
function norm(text: string): string {
	return text.trim().replace(/[！-～]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0xfee0),
	);
}

/**
 * 判断一条修改是否值得沉淀。
 *
 * 过滤掉噪声很重要：把每个字符改动都变成经验，会让注入的上下文
 * 塞满「用户把『的』改成『地』」这类无意义规则，真正的口径反被淹没。
 */
export function isWorthLearning(revision: Revision): boolean {
	const before = norm(revision.before);
	const after = norm(revision.after);

	// 没实际变化
	if (before === after) return false;

	// 用户明确给了原因 → 一定值得学，不管改动多小
	if (revision.reason !== undefined && revision.reason.trim() !== "") return true;

	// 纯删除或纯补充：只要内容有实质长度就值得
	if (revision.kind === RevisionKind.Removal) return before.length >= 4;
	if (revision.kind === RevisionKind.Addition) return after.length >= 4;

	// 措辞替换：太短的改动多半是笔误，不是口径
	// 「负责人」→「责任部门」值得学；「的」→「地」不值得
	if (revision.kind === RevisionKind.Wording) {
		return before.length >= 2 && after.length >= 2;
	}

	return true;
}

/**
 * 把一条修改转成经验规则的描述文本。
 *
 * 措辞刻意保守：用「上次被改为」而非「必须使用」。
 * 断言式的规则会让模型在不适用的场合也硬套 ——
 * 而我们只观察到一次修改，还不知道它是否普适。
 */
export function describeRule(revision: Revision): string {
	const reason =
		revision.reason !== undefined && revision.reason.trim() !== ""
			? `（用户说明：${revision.reason.trim()}）`
			: "";

	switch (revision.kind) {
		case RevisionKind.Wording:
			return `「${revision.target}」处，上次把「${revision.before}」改为「${revision.after}」${reason}`;
		case RevisionKind.Format:
			return `「${revision.target}」的格式，上次由「${revision.before}」改为「${revision.after}」${reason}`;
		case RevisionKind.Structure:
			return `结构上，「${revision.target}」上次由「${revision.before}」调整为「${revision.after}」${reason}`;
		case RevisionKind.Removal:
			return `「${revision.target}」处，上次删除了「${revision.before}」${reason}`;
		case RevisionKind.Addition:
			return `「${revision.target}」处，上次补充了「${revision.after}」${reason}`;
	}
}

/**
 * 经验的去重键。
 *
 * 用 kind + target + before + after 四者。只用 target 会让同一位置的
 * 不同修改互相覆盖；加上前后内容才能区分「这次改的和上次是同一件事」。
 *
 * 分隔符用不可打印字符（与 reconcile.ts 的 KEY_SEP 同一考虑）：
 * 若用空串拼接，「A」+「BC」与「AB」+「C」会得到同一个键。
 */
export function lessonKey(revision: Revision): string {
	return [revision.kind, norm(revision.target), norm(revision.before), norm(revision.after)].join(
		"",
	);
}

export interface LearnOptions {
	readonly tenantId: string;
	readonly scenarioId: string;
	readonly scope?: Scope;
	readonly now?: () => number;
}

/**
 * 从一批修改中学习。
 *
 * 已存在的经验会累加 `timesObserved` 而非新建 —— 这是权重提升的机制。
 */
export async function learnFromRevisions(
	store: LessonStore,
	revisions: readonly Revision[],
	options: LearnOptions,
): Promise<{ readonly learned: Lesson[]; readonly skipped: number }> {
	const now = options.now ?? (() => Date.now());
	const existing = await store.list(options.tenantId, options.scenarioId);
	const byKey = new Map<string, Lesson>();
	for (const lesson of existing) {
		// 用第一条证据重建键 —— 同一经验的证据都有相同的键
		const first = lesson.evidence[0];
		if (first !== undefined) byKey.set(lessonKey(first), lesson);
	}

	const learned: Lesson[] = [];
	let skipped = 0;

	for (const revision of revisions) {
		if (!isWorthLearning(revision)) {
			skipped += 1;
			continue;
		}

		const key = lessonKey(revision);
		const prior = byKey.get(key);

		if (prior !== undefined) {
			// 同一条被再次印证 → 提升权重，不新建
			const updated = await store.upsert({
				...prior,
				timesObserved: prior.timesObserved + 1,
				// 新证据里若带了原因，补进去 —— 用户可能第二次才解释
				evidence: [...prior.evidence, revision],
				updatedAt: now(),
			});
			learned.push(updated);
			continue;
		}

		const created = await store.upsert({
			id: key,
			tenantId: options.tenantId,
			scenarioId: options.scenarioId,
			kind: revision.kind,
			rule: describeRule(revision),
			evidence: [revision],
			timesObserved: 1,
			scope: options.scope ?? ("workspace" as Scope),
			createdAt: now(),
			updatedAt: now(),
		});
		learned.push(created);
		byKey.set(key, created);
	}

	return { learned, skipped };
}

/** 注入上下文时的经验条数上限。太多会挤掉真正的任务数据。 */
export const MAX_INJECTED_LESSONS = 12;

/**
 * 把经验编译成注入模型的上下文片段。
 *
 * 按 `timesObserved` 降序 —— 被反复印证的口径优先，
 * 只出现过一次的放后面甚至被截断掉。
 *
 * 措辞设计很关键：告诉模型这是「本单位的历史修改记录」而非「必须遵守的规则」。
 * 后者会让模型在不适用的场合硬套，产出反而变差。
 */
export function compileLessons(lessons: readonly Lesson[]): string {
	if (lessons.length === 0) return "";

	const sorted = [...lessons]
		.sort((a, b) => b.timesObserved - a.timesObserved || b.updatedAt - a.updatedAt)
		.slice(0, MAX_INJECTED_LESSONS);

	const lines = sorted.map((lesson) => {
		// 被多次印证的标出来，让模型知道这条更可靠
		const weight = lesson.timesObserved >= 2 ? `【已重复 ${lesson.timesObserved} 次】` : "";
		return `· ${weight}${lesson.rule}`;
	});

	return [
		"以下是本单位在同类任务中的历史修改记录。请在本次产出中参照，避免重复被改过的问题：",
		"",
		...lines,
		"",
		"注意：这些是历史偏好而非硬性规则。若本次任务的实际情况与之冲突，以本次要求为准，并在回复中说明。",
	].join("\n");
}

/**
 * 检查一份产出是否重复了已知的错误。
 *
 * 这是 M3 验收门禁的**自动化判据**：同一场景第二次产出，
 * 不该再出现上次被改掉的内容。
 *
 * 用在两处：
 *  - 交付前自检，发现重复犯错时让模型重做
 *  - 验收测试，证明经验回写真的起作用了
 */
export function findRepeatedMistakes(
	output: string,
	lessons: readonly Lesson[],
): Array<{ readonly lesson: Lesson; readonly found: string }> {
	const normalized = norm(output);
	const repeated: Array<{ lesson: Lesson; found: string }> = [];

	for (const lesson of lessons) {
		// 只检查「改掉了某内容」这类经验 —— 补充类经验无法用「是否出现」判断
		if (lesson.kind === RevisionKind.Addition) continue;

		const first = lesson.evidence[0];
		if (first === undefined) continue;

		const mistake = norm(first.before);
		if (mistake === "") continue;

		// 被改掉的内容又出现了，且替换后的内容没出现 → 重复犯错
		const stillThere = normalized.includes(mistake);
		const correctedApplied = normalized.includes(norm(first.after));
		if (stillThere && !correctedApplied) {
			repeated.push({ lesson, found: first.before });
		}
	}

	return repeated;
}
