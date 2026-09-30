/**
 * 平台预置场景卡
 *
 * 场景取自[需求 §2](../../../docs/requirements.md) 列出的两个行业**真实高频产出**，不是编的：
 *
 *  - 高校：通知公文、统计报表、评审材料、评估自评报告、整改台账、会议纪要
 *  - 制造业：生产日报周报、8D 报告、工艺文件与 SOP、供应商对账、设备台账、
 *    ISO9001/IATF16949 体系文件、安全检查记录
 *
 * 每张卡的设计原则：
 *
 *  1. **必需字段只留真正必需的。** 多一个必填就多一道放弃的门槛 ——
 *     目标用户对「看起来很强但用不起来」的工具容忍度极低。
 *  2. **字段标签用用户自己的话。** 「匹配依据」而非「keyColumns」，
 *     「验收要求」而非「acceptance criteria」。
 *  3. **指令模板里写清产出要求。** 模型不知道「整改台账」该有哪些列，
 *     这些领域知识必须由场景卡提供，否则每次产出格式都不一样。
 */

import { FieldType, type ScenarioCard } from "./scenario.ts";
import { Scope } from "./tenant.ts";

/** 平台预置卡的公共属性。 */
const platform = {
	scope: Scope.Platform,
	tenantId: null,
	enabled: true,
} as const;

const XLSX = [".xlsx", ".xls"] as const;
const DOC = [".docx", ".doc"] as const;

// ─────────────────────────────────────────────
// 传统制造业
// ─────────────────────────────────────────────

/** 付费动机直接相关：对账差异要出正式报告发回供应商。 */
const supplierReconcile: ScenarioCard = {
	...platform,
	id: "mfg.supplier-reconcile",
	title: "核对供应商对账单",
	summary: "比对我方台账与供应商对账单，按物料逐项找出数量与金额差异，产出可发回供应商的差异报告",
	industry: "manufacturing",
	category: "采购管理",
	fields: [
		{
			name: "ourLedger",
			label: "我方台账",
			type: FieldType.File,
			required: true,
			accept: XLSX,
			hint: "从 ERP 或进销存导出的明细表",
		},
		{
			name: "supplierBill",
			label: "供应商对账单",
			type: FieldType.File,
			required: true,
			accept: XLSX,
			hint: "供应商发来的对账单",
		},
		{
			name: "keyColumns",
			label: "按什么匹配两张表",
			type: FieldType.MultiSelect,
			required: true,
			options: [
				{ value: "物料编码", label: "物料编码" },
				{ value: "物料名称", label: "物料名称" },
				{ value: "批次", label: "批次号" },
				{ value: "订单号", label: "采购订单号" },
			],
			hint: "通常用物料编码；同物料分批到货时再加批次号",
			defaultValue: ["物料编码"],
		},
		{
			name: "compareColumns",
			label: "要核对哪些数据",
			type: FieldType.MultiSelect,
			required: true,
			options: [
				{ value: "数量", label: "数量" },
				{ value: "单价", label: "单价" },
				{ value: "金额", label: "金额" },
				{ value: "税额", label: "税额" },
			],
			defaultValue: ["数量", "金额"],
		},
		{
			name: "tolerance",
			label: "允许误差",
			type: FieldType.Number,
			required: false,
			min: 0,
			hint: "金额核对建议填 0.01（一分钱）；按件数核对填 0",
		},
	],
	tools: ["list_sheets", "read_table", "reconcile_tables"],
	systemPrompt:
		"你是制造业采购与财务的对账助手。你的产出会被发给供应商并可能进入审计材料，因此必须准确、可追溯，不得臆测缺失的数据。遇到列名不匹配或数据异常时，明确告知用户而不是猜测。",
	promptTemplate: [
		"请核对以下两份文件并产出差异报告：",
		"我方台账：{{ourLedger}}",
		"供应商对账单：{{supplierBill}}",
		"匹配依据：{{keyColumns}}",
		"核对项：{{compareColumns}}",
		"允许误差：{{tolerance}}",
		"",
		"要求：",
		"1. 先读取两张表确认列名与匹配依据一致，若列名不符立即告知用户",
		"2. 核对后产出 xlsx 报告，含汇总页与差异明细页",
		"3. 对仅单方存在的物料单独列出，不要当成数量为零",
	].join("\n"),
};

/** 8D 是汽车与电子行业客户索赔的标准回复格式，格式不对会被退回。 */
const eightDReport: ScenarioCard = {
	...platform,
	id: "mfg.8d-report",
	title: "生成 8D 报告",
	summary: "按 8D 标准八个步骤整理质量问题分析，产出可直接提交客户的报告",
	industry: "manufacturing",
	category: "质量管理",
	fields: [
		{
			name: "problemDescription",
			label: "问题描述",
			type: FieldType.TextArea,
			required: true,
			hint: "客户投诉了什么？什么时候发现的？影响了多少产品？",
		},
		{
			name: "productInfo",
			label: "产品与批次",
			type: FieldType.Text,
			required: true,
			hint: "如：刹车盘 BP-2024，批次 20260801-20260815",
		},
		{
			name: "customer",
			label: "客户名称",
			type: FieldType.Text,
			required: false,
		},
		{
			name: "rootCause",
			label: "已查明的原因",
			type: FieldType.TextArea,
			required: false,
			hint: "若已有初步分析结论请填写；留空则由助手提示你需要补充哪些排查",
		},
		{
			name: "evidence",
			label: "检测数据或记录",
			type: FieldType.FileList,
			required: false,
			accept: [...XLSX, ".pdf", ".jpg", ".png"],
			hint: "检验报告、SPC 数据、现场照片",
		},
		{
			name: "deadline",
			label: "客户要求回复期限",
			type: FieldType.Date,
			required: false,
		},
	],
	tools: ["read_table", "write_document"],
	systemPrompt:
		"你是质量工程师助手，精通 8D 问题解决方法与 IATF16949 要求。8D 报告会直接提交给客户，格式不符会被退回。你必须严格按 D1-D8 八个步骤组织内容，对信息不足的步骤明确标注「待补充」并说明需要什么，绝不编造根本原因或验证数据。",
	promptTemplate: [
		"请生成一份 8D 报告。",
		"问题描述：{{problemDescription}}",
		"产品与批次：{{productInfo}}",
		"客户：{{customer}}",
		"已查明的原因：{{rootCause}}",
		"检测数据：{{evidence}}",
		"回复期限：{{deadline}}",
		"",
		"要求：",
		"1. 严格按 D1 小组成立、D2 问题描述、D3 临时措施、D4 根本原因、D5 永久措施、D6 效果验证、D7 预防再发、D8 小组表彰 组织",
		"2. 信息不足的步骤标注「待补充」并列出需要用户提供什么，不要编造",
		"3. 根本原因分析要体现 5Why 或鱼骨图的推理过程，而非直接给结论",
	].join("\n"),
};

/** 验厂前的集中准备，也是日常内审的产出。 */
const inspectionChecklist: ScenarioCard = {
	...platform,
	id: "mfg.inspection-checklist",
	title: "整理安全检查记录",
	summary: "把现场检查的零散记录整理成规范的检查表与整改清单",
	industry: "manufacturing",
	category: "安全管理",
	fields: [
		{
			name: "rawRecords",
			label: "现场检查记录",
			type: FieldType.FileList,
			required: true,
			accept: [...XLSX, ...DOC, ".txt"],
			hint: "手写记录的照片转录、Excel 草表都可以",
		},
		{
			name: "checkType",
			label: "检查类型",
			type: FieldType.Select,
			required: true,
			options: [
				{ value: "日常巡检", label: "日常巡检" },
				{ value: "专项检查", label: "专项检查" },
				{ value: "节前检查", label: "节假日前检查" },
				{ value: "验厂准备", label: "客户验厂准备" },
			],
		},
		{
			name: "area",
			label: "检查区域",
			type: FieldType.Text,
			required: false,
			hint: "如：冲压车间、成品仓库",
		},
	],
	tools: ["read_table", "write_document"],
	systemPrompt:
		"你是安全管理助手。产出会用于安全档案与客户验厂，需规范、可核查。对记录中描述模糊的隐患，保留原始描述并标注「描述需确认」，不要自行改写成看起来规范但失真的表述。",
	promptTemplate: [
		"请把以下现场检查记录整理成规范的检查表与整改清单：",
		"检查记录：{{rawRecords}}",
		"检查类型：{{checkType}}",
		"检查区域：{{area}}",
		"",
		"要求：",
		"1. 检查表含：序号、检查项、检查结果、发现问题、风险等级、责任人、整改期限",
		"2. 整改清单只列出不合格项，按风险等级排序",
		"3. 原始记录里描述模糊的保留原文并标注「描述需确认」",
	].join("\n"),
};

/** 生产日报周报是最高频的重复劳动。 */
const productionReport: ScenarioCard = {
	...platform,
	id: "mfg.production-report",
	title: "生成生产日报周报",
	summary: "从生产数据汇总产量、良率、异常，产出格式统一的日报或周报",
	industry: "manufacturing",
	category: "生产管理",
	fields: [
		{
			name: "productionData",
			label: "生产数据",
			type: FieldType.FileList,
			required: true,
			accept: XLSX,
			hint: "产量记录、检验记录、设备台账导出表",
		},
		{
			name: "period",
			label: "报表周期",
			type: FieldType.Select,
			required: true,
			options: [
				{ value: "日报", label: "日报" },
				{ value: "周报", label: "周报" },
				{ value: "月报", label: "月报" },
			],
		},
		{
			name: "metrics",
			label: "要统计的指标",
			type: FieldType.MultiSelect,
			required: true,
			options: [
				{ value: "产量", label: "产量" },
				{ value: "良率", label: "良率／一次合格率" },
				{ value: "设备稼动率", label: "设备稼动率" },
				{ value: "异常停机", label: "异常停机时长" },
				{ value: "在制品", label: "在制品数量" },
			],
			defaultValue: ["产量", "良率"],
		},
		{
			name: "compareWithLast",
			label: "是否与上期对比",
			type: FieldType.Boolean,
			required: false,
			defaultValue: true,
		},
	],
	tools: ["list_sheets", "read_table", "reconcile_tables", "write_document"],
	systemPrompt:
		"你是生产管理助手。报表会上报管理层用于决策，数字必须准确且口径一致。计算指标时先说明口径（如良率 = 合格数 / 投入数），若数据不足以计算某指标，明确说明缺什么而不是用近似值代替。",
	promptTemplate: [
		"请生成生产{{period}}。",
		"生产数据：{{productionData}}",
		"统计指标：{{metrics}}",
		"与上期对比：{{compareWithLast}}",
		"",
		"要求：",
		"1. 先说明每个指标的计算口径",
		"2. 数据不足以计算的指标明确列出缺什么，不要用近似值",
		"3. 异常项（良率低于目标、非计划停机）单独突出",
	].join("\n"),
};

/** 体系文件维护：同一套事实要按不同标准维护多份，口径不一致会被开不符合项。 */
const systemDocument: ScenarioCard = {
	...platform,
	id: "mfg.system-document",
	title: "编写体系文件与 SOP",
	summary: "按 ISO9001 / IATF16949 要求编写或修订程序文件、作业指导书",
	industry: "manufacturing",
	category: "质量管理",
	fields: [
		{
			name: "docType",
			label: "文件类型",
			type: FieldType.Select,
			required: true,
			options: [
				{ value: "程序文件", label: "程序文件" },
				{ value: "作业指导书", label: "作业指导书（SOP）" },
				{ value: "管理办法", label: "管理办法" },
				{ value: "检验规范", label: "检验规范" },
			],
		},
		{
			name: "subject",
			label: "文件主题",
			type: FieldType.Text,
			required: true,
			hint: "如：不合格品控制程序、冲压工序作业指导书",
		},
		{
			name: "standard",
			label: "依据标准",
			type: FieldType.MultiSelect,
			required: true,
			options: [
				{ value: "ISO9001", label: "ISO9001" },
				{ value: "IATF16949", label: "IATF16949" },
				{ value: "ISO14001", label: "ISO14001" },
				{ value: "ISO45001", label: "ISO45001" },
				{ value: "客户特殊要求", label: "客户特殊要求" },
			],
		},
		{
			name: "existingDoc",
			label: "现有版本",
			type: FieldType.File,
			required: false,
			accept: DOC,
			hint: "修订已有文件时上传；新建则留空",
		},
		{
			name: "requirements",
			label: "本次要求",
			type: FieldType.TextArea,
			required: false,
			hint: "如：补充客户新增的追溯要求；审核开出的不符合项要闭环",
		},
	],
	tools: ["read_document", "write_document", "search_knowledge"],
	systemPrompt:
		"你是体系文件编写助手，熟悉 ISO9001 与 IATF16949 条款。体系文件会被审核员逐条对照标准检查，口径不一致会被开不符合项。编写时必须标注对应的标准条款号，引用企业已有文件时注明来源。不确定标准具体要求时明确说明，不要臆造条款号。",
	promptTemplate: [
		"请编写{{docType}}。",
		"主题：{{subject}}",
		"依据标准：{{standard}}",
		"现有版本：{{existingDoc}}",
		"本次要求：{{requirements}}",
		"",
		"要求：",
		"1. 含目的、适用范围、职责、流程、记录表单、相关文件六个部分",
		"2. 每个条款标注对应的标准条款号",
		"3. 不确定标准具体要求时明确说明，不要臆造条款号",
		"4. 若上传了现有版本，明确标出本次修改了哪些部分",
	].join("\n"),
};

// ─────────────────────────────────────────────
// 高校服务机构
// ─────────────────────────────────────────────

/** 评估材料是周期性脉冲需求，有硬截止日期。 */
const selfAssessment: ScenarioCard = {
	...platform,
	id: "univ.self-assessment",
	title: "撰写评估自评报告",
	summary: "按评估指标体系逐项组织材料与数据，产出自评报告",
	industry: "university",
	category: "教学管理",
	fields: [
		{
			name: "indicatorSystem",
			label: "评估指标体系",
			type: FieldType.File,
			required: true,
			accept: [...DOC, ...XLSX, ".pdf"],
			hint: "上级下发的评估指标文件",
		},
		{
			name: "materials",
			label: "支撑材料",
			type: FieldType.FileList,
			required: true,
			accept: [...DOC, ...XLSX, ".pdf"],
			hint: "各部门提供的数据表、制度文件、工作总结",
		},
		{
			name: "scope",
			label: "评估范围",
			type: FieldType.Text,
			required: true,
			hint: "如：本科教学工作合格评估；某专业认证",
		},
		{
			name: "indicators",
			label: "本次要写的指标项",
			type: FieldType.TextArea,
			required: false,
			hint: "留空则覆盖全部指标；也可只写某几项，如「4.1 师资队伍、4.2 教学条件」",
		},
	],
	tools: ["read_document", "read_table", "write_document", "search_knowledge"],
	systemPrompt:
		"你是高校评估材料撰写助手。自评报告会被专家组逐项对照指标审阅，每个结论都需要材料支撑。严禁编造数据或材料 —— 支撑材料里没有的数据，标注「数据待补充」并说明需要哪个部门提供什么。引用材料时注明来源文件与位置。",
	promptTemplate: [
		"请撰写评估自评报告。",
		"评估范围：{{scope}}",
		"指标体系：{{indicatorSystem}}",
		"支撑材料：{{materials}}",
		"本次要写的指标项：{{indicators}}",
		"",
		"要求：",
		"1. 严格按指标体系的层级与编号组织，不改动指标表述",
		"2. 每个结论后标注支撑材料来源（文件名与位置）",
		"3. 材料中缺失的数据标注「数据待补充」并说明需要哪个部门提供什么，绝不编造",
		"4. 区分「已达成」与「持续改进中」，不要把计划写成已完成",
	].join("\n"),
};

/** 整改台账是评估检查后的必交产物。 */
const rectificationLedger: ScenarioCard = {
	...platform,
	id: "univ.rectification-ledger",
	title: "整理整改台账",
	summary: "把检查反馈的问题整理成带责任人、期限、进度的整改台账",
	industry: "university",
	category: "行政管理",
	fields: [
		{
			name: "feedback",
			label: "检查反馈意见",
			type: FieldType.FileList,
			required: true,
			accept: [...DOC, ...XLSX, ".pdf", ".txt"],
			hint: "上级检查反馈函、专家意见汇总",
		},
		{
			name: "deadline",
			label: "整改总期限",
			type: FieldType.Date,
			required: false,
		},
		{
			name: "departments",
			label: "涉及部门",
			type: FieldType.Text,
			required: false,
			hint: "如：教务处、学生处、后勤保障部",
		},
		{
			name: "existingLedger",
			label: "已有台账",
			type: FieldType.File,
			required: false,
			accept: XLSX,
			hint: "更新已有台账时上传，会保留原有进度记录",
		},
	],
	tools: ["read_document", "read_table", "write_document"],
	systemPrompt:
		"你是高校行政管理助手。整改台账要上报并被复查，每条问题必须可追溯到原始反馈意见。拆解问题时保留反馈原文，不要改写成模糊表述。责任部门无法从反馈中判断时标注「待分工」，不要随意指派。",
	promptTemplate: [
		"请整理整改台账。",
		"检查反馈：{{feedback}}",
		"整改总期限：{{deadline}}",
		"涉及部门：{{departments}}",
		"已有台账：{{existingLedger}}",
		"",
		"要求：",
		"1. 台账含：序号、问题描述、反馈来源、整改措施、责任部门、责任人、完成期限、当前进度",
		"2. 每条问题保留反馈原文，不要改写成模糊表述",
		"3. 责任部门无法判断的标注「待分工」，不要随意指派",
		"4. 若上传了已有台账，保留原有进度记录并标出新增条目",
	].join("\n"),
};

/** 通知公文是日常最高频的产出。 */
const officialNotice: ScenarioCard = {
	...platform,
	id: "univ.official-notice",
	title: "起草通知公文",
	summary: "按党政机关公文格式起草通知、通报、会议纪要",
	industry: "university",
	category: "行政管理",
	fields: [
		{
			name: "docType",
			label: "文种",
			type: FieldType.Select,
			required: true,
			options: [
				{ value: "通知", label: "通知" },
				{ value: "通报", label: "通报" },
				{ value: "会议纪要", label: "会议纪要" },
				{ value: "工作方案", label: "工作方案" },
				{ value: "情况报告", label: "情况报告" },
			],
		},
		{
			name: "subject",
			label: "主要内容",
			type: FieldType.TextArea,
			required: true,
			hint: "要通知什么事、面向谁、有什么要求或时间节点",
		},
		{
			name: "issuer",
			label: "发文单位",
			type: FieldType.Text,
			required: false,
		},
		{
			name: "reference",
			label: "参考文件",
			type: FieldType.FileList,
			required: false,
			accept: [...DOC, ".pdf"],
			hint: "上级文件、本单位同类历史公文（用于统一口径与格式）",
		},
	],
	tools: ["read_document", "write_document", "search_knowledge"],
	systemPrompt:
		"你是高校公文写作助手，熟悉《党政机关公文格式》国家标准。公文会正式发布，格式与用语必须规范。若提供了本单位历史公文，优先沿用其格式与称谓习惯。涉及具体时间、地点、人员而用户未提供时，用方括号占位如「[会议时间]」，不要编造。",
	promptTemplate: [
		"请起草一份{{docType}}。",
		"主要内容：{{subject}}",
		"发文单位：{{issuer}}",
		"参考文件：{{reference}}",
		"",
		"要求：",
		"1. 符合党政机关公文格式：标题、主送机关、正文、附件说明、发文机关署名、成文日期",
		"2. 若提供了参考文件，沿用其格式与称谓习惯",
		"3. 用户未提供的具体信息用方括号占位如「[会议时间]」，不要编造",
	].join("\n"),
};

/** 「一张表工程」的核心痛点：多部门数据口径不一。 */
const dataCrossCheck: ScenarioCard = {
	...platform,
	id: "univ.data-cross-check",
	title: "多部门数据交叉核对",
	summary: "核对多个部门上报的同一指标数据，找出口径不一致与数据冲突",
	industry: "university",
	category: "数据治理",
	fields: [
		{
			name: "tables",
			label: "各部门数据表",
			type: FieldType.FileList,
			required: true,
			accept: XLSX,
			hint: "至少两份。如教务处与学生处各自统计的在校生数",
		},
		{
			name: "keyColumns",
			label: "按什么匹配",
			type: FieldType.MultiSelect,
			required: true,
			options: [
				{ value: "学号", label: "学号" },
				{ value: "专业代码", label: "专业代码" },
				{ value: "学院", label: "学院" },
				{ value: "年级", label: "年级" },
				{ value: "项目编号", label: "项目编号" },
			],
		},
		{
			name: "compareColumns",
			label: "要核对哪些数据",
			type: FieldType.MultiSelect,
			required: true,
			options: [
				{ value: "人数", label: "人数" },
				{ value: "金额", label: "金额" },
				{ value: "数量", label: "数量" },
				{ value: "学时", label: "学时" },
			],
		},
	],
	tools: ["list_sheets", "read_table", "reconcile_tables"],
	systemPrompt:
		"你是高校数据治理助手。重复填表与口径不一致是高校信息化的首要痛点。核对时不仅要找出数值差异，还要指出可能的口径差异原因（如统计时点不同、是否含留学生、是否含休学）。不要直接断定哪一方是错的。",
	promptTemplate: [
		"请交叉核对以下各部门数据表：",
		"数据表：{{tables}}",
		"匹配依据：{{keyColumns}}",
		"核对项：{{compareColumns}}",
		"",
		"要求：",
		"1. 逐项列出数值差异，产出 xlsx 报告",
		"2. 对差异给出可能的口径原因推测（统计时点、统计范围），但不断定哪方是错的",
		"3. 仅单方存在的记录单独列出",
	].join("\n"),
};

/** 科研管理的高频产出。 */
const projectApplication: ScenarioCard = {
	...platform,
	id: "univ.project-application",
	title: "整理项目申报书",
	summary: "按申报指南要求整理项目申报材料，检查完整性与格式规范",
	industry: "university",
	category: "科研管理",
	fields: [
		{
			name: "guideline",
			label: "申报指南",
			type: FieldType.File,
			required: true,
			accept: [...DOC, ".pdf"],
			hint: "上级发布的申报通知或指南",
		},
		{
			name: "materials",
			label: "已有材料",
			type: FieldType.FileList,
			required: true,
			accept: [...DOC, ...XLSX, ".pdf"],
			hint: "项目基本情况、团队成员、前期成果、预算表",
		},
		{
			name: "projectName",
			label: "项目名称",
			type: FieldType.Text,
			required: true,
		},
		{
			name: "checkOnly",
			label: "仅检查完整性",
			type: FieldType.Boolean,
			required: false,
			hint: "勾选则只输出缺失清单，不生成申报书正文",
			defaultValue: false,
		},
	],
	tools: ["read_document", "read_table", "write_document", "search_knowledge"],
	systemPrompt:
		"你是科研管理助手。申报书形式审查不通过会直接失去申报机会，因此完整性检查比文字润色更重要。逐条对照申报指南的要求清单核查材料，缺失项明确指出需要补什么。不要为了让申报书看起来完整而编造成果或数据。",
	promptTemplate: [
		"请整理项目申报材料。",
		"项目名称：{{projectName}}",
		"申报指南：{{guideline}}",
		"已有材料：{{materials}}",
		"仅检查完整性：{{checkOnly}}",
		"",
		"要求：",
		"1. 先逐条对照申报指南列出材料完整性检查表，缺失项明确指出需要补什么",
		"2. 检查格式要求（页数限制、字体、是否需要盖章件）",
		"3. 绝不编造成果或数据来填补缺失",
	].join("\n"),
};

/** 全部平台预置场景卡。 */
export const PRESET_CARDS: readonly ScenarioCard[] = [
	// 制造业 5 个
	supplierReconcile,
	eightDReport,
	inspectionChecklist,
	productionReport,
	systemDocument,
	// 高校 5 个
	selfAssessment,
	rectificationLedger,
	officialNotice,
	dataCrossCheck,
	projectApplication,
];

/** 按行业取场景卡，用于首页分组展示。 */
export function cardsByIndustry(industry: ScenarioCard["industry"]): ScenarioCard[] {
	return PRESET_CARDS.filter((c) => c.industry === industry);
}
