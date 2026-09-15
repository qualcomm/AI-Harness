# dragon-router 路由矩阵手动测试用例

覆盖 **隐私级别 × 任务复杂度** 的完整路由面：
- **S1 × tier 1–5**（安全 → 判复杂度 → 直连对应 tier 模型）
- **S2 × tier 1–5**（含 PII → 可逆脱敏 → 走本地代理 → tier 模型）
- **S3**（高敏感 → 本地 s3Model，不判复杂度、数据不出端）

分级标准来源：[prompts/privacy-detection.md](../prompts/privacy-detection.md)、[prompts/complexity-classify.md](../prompts/complexity-classify.md)。

---

## 一、前置准备

1. `openclaw.json` 中 `plugins.allow` 含 `dragon-router`，`entries.dragon-router.enabled=true`。
2. `localModel` 指向**可达**的本地模型（隐私/复杂度/脱敏都靠它），日志出现：
   `[dragon-router] init — localModel=…`
3. 代理服务已起：`[dragon-router:proxy] listening on http://127.0.0.1:<proxyPort>`。
4. 每条用例**换新会话或等 5 分钟**再测——分类结果按 SHA-256(prompt) 缓存 `cacheTtlMs`（默认 5min），相同 prompt 会命中缓存不再重判。
5. `complexityTiers` / `s3Model` 引用的 provider 已在 `models.providers` 注册且带正确 apiKey。

### 如何读日志判定结果

| 日志行 | 含义 |
| --- | --- |
| `session=… privacy=SN` | 隐私判定结果（[hooks.ts:37](../src/hooks.ts#L37)） |
| `S1 tier=N → provider/model` | S1 直连目标（[hooks.ts:56-58](../src/hooks.ts#L56)） |
| `S2 tier=N → proxy → provider/model (K PII)` | S2 经代理，K=脱敏条数（[hooks.ts:89-91](../src/hooks.ts#L89)） |
| `S3 → local provider/model` | S3 本地目标（[hooks.ts:43-44](../src/hooks.ts#L43)） |
| `provider overridden to …` / `model overridden to …` | 框架实际生效的路由 |

> 复杂度由本地模型**现场判定**，同一句话不同模型可能给出相邻 tier（±1）。下列提示词按 prompt 规则设计为"典型命中"，**以实际日志的 `tier=N` 为准**。

---

## 二、S1 × tier 1–5（安全内容，直连 tier 模型）

S1 判据：无 PII、无凭证/医疗/财务。complexity 分级见 complexity-classify.md 的 Tier 1–5 定义。

| # | 提示词 | 期望 tier | 期望路由 | 复杂度依据 |
| --- | --- | --- | --- | --- |
| S1-T1 | `帮我把这句话总结成一句：人工智能正在改变各行各业，从医疗到交通都出现了自动化的趋势，也带来了新的挑战。` | 1 | 直连 `complexityTiers.1` | 总结单段文本 → Tier 1(SIMPLE) |
| S1-T2 | `帮我写一封请假邮件给经理，说明我明天因家中有事需要请假一天。` | 2 | 直连 `complexityTiers.2` | 写邮件 → Tier 2(MEDIUM) |
| S1-T3 | `我有一个包含多封客户邮件的文件夹，帮我逐封筛查并把投诉类的挑出来分类整理。` | 3 | 直连 `complexityTiers.3` | 多项结构化处理 → Tier 3(COMPLEX) |
| S1-T4 | `根据我提供的三份调研资料，综合写成一篇关于新能源汽车市场趋势的长篇博客文章。` | 4 | 直连 `complexityTiers.4` | 多源综合长文 → Tier 4(RESEARCH) |
| S1-T5 | `帮我阅读这份 PDF 技术白皮书，理解其中的架构设计并用通俗易懂的语言解释给非技术人员听。` | 5 | 直连 `complexityTiers.5` | PDF 深度分析/通俗解释 → Tier 5(REASONING) |

**每条验证点**：
- 日志 `privacy=S1`；
- 日志 `S1 tier=N → <期望 provider>/<期望 model>`，与 openclaw.json 的 `complexityTiers.N` 一致；
- **不经代理**（provider 不是 `dragon-router-proxy`）；
- webui 得到正常回复（若目标模型本身有空回复问题，另查模型配置，与路由无关）。

---

## 三、S2 × tier 1–5（含 PII，脱敏后经代理）

S2 判据：含普通 PII（姓名/电话/地址/邮箱等）但**不含**凭证/医疗/财务。
构造技巧：在每个 tier 的任务里**塞入 PII**，使隐私判为 S2、复杂度仍落在目标 tier。

| # | 提示词 | 期望 tier | 期望路由 | 说明 |
| --- | --- | --- | --- | --- |
| S2-T1 | `帮我把这句话改写得更礼貌：张伟你赶紧把电话13912345678发我。` | 1 | 代理 → `complexityTiers.1.model` | 改写短句(T1) + 姓名/电话(S2) |
| S2-T2 | `帮李娜写一封邮件邀请她参加周五的会议，她的邮箱是 lina@example.com。` | 2 | 代理 → `complexityTiers.2.model` | 写邮件(T2) + 姓名/邮箱(S2) |
| S2-T3 | `我这里有多位访客的登记信息，帮我逐条整理成表格：王强 13800001111、赵敏 13900002222、孙俊 13700003333。` | 3 | 代理 → `complexityTiers.3.model` | 多项结构化整理(T3) + 多个姓名/电话(S2) |
| S2-T4 | `根据这几份资料，综合写一篇社区活动纪实长文，负责人陈磊，联系电话13611112222，地址北京市朝阳区幸福路5号。` | 4 | 代理 → `complexityTiers.4.model` | 多源综合长文(T4) + 姓名/电话/地址(S2) |
| S2-T5 | `帮我阅读这份 PDF 调研报告并通俗解释其结论，报告作者刘洋，邮箱 liuyang@example.com。` | 5 | 代理 → `complexityTiers.5.model` | PDF 通俗解释(T5) + 姓名/邮箱(S2) |

**每条验证点**：
- 日志 `privacy=S2`；
- 日志 `S2 tier=N → proxy → …/<model> (K PII)`，K = 该句 PII 条数；
- **provider 被 override 为 `dragon-router-proxy`**，model 为 `complexityTiers.N.model`；
- 发往云端上游的请求体中，姓名/电话/邮箱/地址等已被替换为 `⟦PII_xxxx⟧` 占位符（抓包/上游日志确认）；
- 返回给用户的最终文本中，占位符已**还原**为真实值（反脱敏生效）。

> S2 依赖 PII 提取成功（本地模型返回 PII 数组）。若本地模型未提取到任何 PII，`items=0` 仍会经代理但无占位符替换；若脱敏调用**抛错**，则按 fail-safe 转本地处理（见下表 E4）。

---

## 四、S3（高敏感，本地处理，不出端）

S3 判据：凭证/密钥/密码、财务（工资单/银行账户/税表）、医疗（病历/体检报告），或读取分析上述文件。**恒为 S3，不判复杂度。**

| # | 提示词 | 期望级别 | 期望路由 |
| --- | --- | --- | --- |
| S3-a | `我的数据库密码是 hunter2，帮我检查这段连接配置是否正确。` | S3 | 本地 `s3Model` |
| S3-b | `这是我的 API key：sk-abc123456，帮我写调用示例。` | S3 | 本地 `s3Model` |
| S3-c | `帮我分析这份工资单，我的月薪是 25000，各项扣除是否合理？` | S3 | 本地 `s3Model` |
| S3-d | `读取我的体检报告并总结其中的异常指标。` | S3 | 本地 `s3Model` |

**每条验证点**：
- 日志 `privacy=S3`；
- 日志 `S3 → local <s3Model.provider>/<s3Model.model>`；
- **无云端上游请求**（数据不出端）——抓包/上游日志应无对应调用；
- **不出现** `tier=` 日志（S3 不判复杂度）。

> ⚠️ 当前配置风险：若 `s3Model` 仍指向云端 provider（如 `bytedance-coding`），则"数据不出端"语义**不成立**——S3 内容会被发往云端。要真正验证不出端，需先把 `s3Model` 改为本地 provider。

---

## 五、Fail-safe 兜底（可靠性附加验证）

| # | 注入故障 | 期望行为 | 依据 |
| --- | --- | --- | --- |
| E1 | 停掉本地模型（localModel 端点下线） | 任意提示词均判 **S3** → 本地处理，绝不外泄 | [privacy-detector.ts:51-54](../src/privacy-detector.ts#L51) |
| E2 | 本地模型返回无法解析的隐私结果 | 视为 **S2**（偏保守） | [privacy-detector.ts:48](../src/privacy-detector.ts#L48) |
| E3 | 复杂度判定返回无法解析 | 落到 **tier 2**（MEDIUM，已统一兜底） | [complexity-classifier.ts:47,51](../src/complexity-classifier.ts#L47) |
| E4 | S2 场景脱敏调用抛错 | 按 S3 本地处理，PII 不出端 | [hooks.ts:67-76](../src/hooks.ts#L67) |
| E5 | 空 / 纯空白提示词 | 不做任何路由（直接跳过） | [hooks.ts:34](../src/hooks.ts#L34) |

---

## 六、快速对照表（期望路由汇总）

| 场景 | privacy 日志 | provider override | model override |
| --- | --- | --- | --- |
| S1-T1 | S1 | `complexityTiers.1.provider` | `complexityTiers.1.model` |
| S1-T2 | S1 | `complexityTiers.2.provider` | `complexityTiers.2.model` |
| S1-T3 | S1 | `complexityTiers.3.provider` | `complexityTiers.3.model` |
| S1-T4 | S1 | `complexityTiers.4.provider` | `complexityTiers.4.model` |
| S1-T5 | S1 | `complexityTiers.5.provider` | `complexityTiers.5.model` |
| S2-T1 | S2 | `dragon-router-proxy` | `complexityTiers.1.model` |
| S2-T2 | S2 | `dragon-router-proxy` | `complexityTiers.2.model` |
| S2-T3 | S2 | `dragon-router-proxy` | `complexityTiers.3.model` |
| S2-T4 | S2 | `dragon-router-proxy` | `complexityTiers.4.model` |
| S2-T5 | S2 | `dragon-router-proxy` | `complexityTiers.5.model` |
| S3-* | S3 | `s3Model.provider` | `s3Model.model` |
