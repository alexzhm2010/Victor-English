# 单词扫描 · 背词器（第一版）

一个面向整本英语单词书的扫描背词工具。第一版只做三件事：**拍照上传 → 扫描拆解入库 → 查询单词列表**。

技术栈：原生前端（无需构建）+ Supabase（Postgres 数据库 / Storage / Edge Function）+ 多模态 AI（默认豆包 Seed 2.1 Lite）。

---

## ⚡ 当前联调状态（已部署）

- **后端项目**：Supabase `gjtjivmxxelnousbqmok`（alexzhm@126.com），区域 ap-south-1
- **隔离方案**：因该项目已有 4345 条生产 words 数据，本工具所有表统一用 `vw_` 前缀（`vw_books/vw_words/vw_senses/vw_examples/vw_scan_batches` + 视图 `vw_vocab`），**与现有业务表完全隔离**，生产数据零改动
- **Storage 桶**：`vocab-pages`（公开读、允许匿名上传）
- **Edge Functions**：`detect-page`（识别图片真实页码）与 `scan-page`（拆解入库）均已部署，`verify_jwt=false`，走豆包 OpenAI 兼容接口
- **已入库样例**：P123 的 8 词条 / 20 义项 / 54 例句（book_id=`victor`），前端词库页可直接查询
- **前端**：已预置该项目 URL 与 anon key，打开即在线模式；线上地址见对话中的分享链接
- **AI 已配置并验证通过**：方舟密钥 `ARK_API_KEY` 与模型 `doubao-seed-2-1-lite-260915` 已写入 Supabase Secrets（你的账号实际开通了 Lite，Turbo/Pro 未开通）。已用真实 P123 扫描图端到端验证：豆包识别出 8 词条 / 19 义项 / 55 例句并成功入库，耗时约 41 秒。函数已关闭思维链以省 token、提速。
- **页码主导版**：去重主键升级为 `(book_id, headword, page_no)`，新增 `partial` 半截词标记与跨页补全。迁移脚本：`supabase/migration_pagekey.sql`（已执行）。
- **页码从图片读取版（最新）**：新增 `detect-page` 逐张识别图片印刷页码并入库，扫描改为「先识别页码并排序 → 再按页码顺序入库」两阶段；弹框只显示最大页码 + 单个「开始」按钮；最大页码权威来源改为 `vw_scan_batches` 表。历史页码已用回填脚本写入该表（`victor` 仍为 123）。实测：图片印刷页码 1 → 函数返回 1，即便误传期望页码 6 也不受影响。
- 如需换模型，用 `supabase secrets set AI_MODEL=<模型ID> --yes`（模型 ID 需带版本后缀，且账号已开通；可在方舟控制台 Models 页确认）

> 安全提示：初始联调用的 Supabase PAT 曾在对话中明文出现，联调完成后建议到 Supabase Account → Access Tokens 撤销并重新生成。

### 版本号与更新日志（怎么知道功能落地没有）
首页顶部有**绿色版本卡片**（显示当前版本号 + 最新功能要点），标题栏右上角也有小版本号；点版本卡片可展开全部历史版本。
- **维护方式（集中一处）**：`app.js` 顶部的 `CHANGELOG` 数组。每次改完功能，**在最前面加一条** `{ v:'新版本', date:'YYYY-MM-DD', items:['改了什么'] }` 即可，首页会自动显示新版本号与要点，无需改 HTML。
- 版本规则：功能新增/行为变化升 minor（1.6.0 → 1.7.0），小修小补升 patch（1.6.0 → 1.6.1）。
- 当前版本：**v2.0.0**（按整书版式规则重写解析，准确度升级）。

---

## 一、目录结构

```
背单词工具/
├── index.html                        前端主页面（双击即可打开）
├── app.js                            前端逻辑
├── demo-data.js                      演示数据（P123 真实解析结果）
├── 版式规则手册.md                    整书版式/符号规则（喂图 21 页 + 2 页图例归纳）
├── 改进方案_v2.md                     v2 数据库与提示词改进方案（含决策）
├── README.md                         本文档
└── supabase/
    ├── schema.sql                    原始建表脚本（早期版本，生产以 vw_ 表为准）
    ├── schema_isolated.sql           vw_ 隔离表建表脚本
    ├── migration_pagekey.sql         页码主导 + partial 迁移（已执行）
    ├── migration_v2_accuracy.sql     v2 解析精准度迁移（待执行）
    ├── config.toml                   函数配置（两个函数均 verify_jwt=false）
    ├── functions/detect-page/
    │   └── index.ts                  图片印刷页码识别 Edge Function
    └── functions/scan-page/
        ├── index.ts                  扫描拆解 Edge Function
        └── 说明.txt                  环境变量与部署说明
```

---

## 二、批量扫描与跨页合并（核心机制）

### 扫描进度提示（拍照前弹框）
- 每次点「拍照 / 选择多张图片」，先弹框显示**「上次扫描到第 n 页」**（n = 从**页码表** `vw_scan_batches` 查 `MAX(page_no)`）
- **进度带会话内缓存**：同一本书只查一次数据库，页面初始化预取后，点弹框直接读缓存、秒开（修复"读取进度很慢"）；入库成功后缓存自动失效
- 弹框**只有一个「▶️ 开始」按钮**：点它直接打开相机/相册，**不再选择页码**——每张图的页码一律从图片上印刷的页码识别
- 扫描页常驻显示「📖 上次扫描到第 n 页」

### 网络稳定性（修复 "Failed to fetch"）
- 手机网络下长时间请求易被中断（截图里的 `Failed to fetch` 是网络层错误，非函数报错）。所有关键请求（上传 / 页码识别 / 扫描解析 / 词库查询）统一走 `fetchWithRetry`：带超时 + 网络错误自动重试 + 中文可读报错
- 扫描解析一页约 40 秒，超时放宽到 150 秒并重试 1 次；入库按 `(book,headword,page_no)` upsert 幂等，重试不会产生重复数据
- Edge Function 例句写入改为批量 insert，减少数据库往返、缩短函数耗时

### 省流优化（降低单页成本，均已落地）
当前模型 `doubao-seed-2.1-lite` 官方价：输入 0.80 元/百万 token、输出 2.70 元/百万 token；缓存命中输入仅 0.16 元/百万（1/5）。据此做了三处优化，单页成本约 1～2 分钱：
1. **上传前压缩图片**（`app.js` 的 `compressImage`）：长边上限 1920px、JPEG 质量 0.82，等比缩放后再上传；detect 与 scan 复用同一压缩图。多模态 token 由分辨率决定，实测原图 1600×2352 → 1306×1920，分辨率与 token 明显下降。压缩失败或已够小自动回退原图，不影响可用性。常量 `IMG_MAX_SIDE / IMG_QUALITY` 可调。
2. **精简拆解提示词**（`scan-page` 的 `SYSTEM_PROMPT`）：去掉示例里的空字段占位、合并冗余说明，并让 AI「无值字段直接省略」。提示词约 1087 → 766 token（-30%）；更重要的是让模型输出紧凑 JSON，减少输出 token（输出单价是输入的 3 倍多）。解析端全部字段有 `|| null` 容错，省略空字段不影响入库质量。
3. **命中前缀缓存**：火山方舟的透明前缀缓存**自动生效、无需配置**，前提是 system 提示词字节级稳定。两个函数的 `SYSTEM_PROMPT` 都是纯静态常量（无插值），动态内容（页码、跨页上下文、图片）全在 user 消息里——因此每页调用都能命中缓存，system 部分按 0.16 元/百万计费。
- 补充：火山方舟还有「低优 / 批量推理」档位（约常规半价：输入 0.40、输出 1.35），但这是**创建接入点时选定的付费方式，不能靠改 API 请求参数切换**；若以后走大批量离线导入，可在控制台另建低优接入点，届时把 `AI_BASE_URL` 指向它即可，无需改代码逻辑。

### 批量上传 / 统一提交（默认）
- **拍照支持连续拍摄**：点「拍照」进入自定义相机界面（getUserMedia 实时取景），点快门抓帧存入队列，**界面不退出、可连续拍多张**，顶部显示"本次已拍 N 张 · 队列 n/15"，点「完成，返回列表」才关闭相机并释放摄像头。不支持 getUserMedia 的环境（如非 HTTPS）自动回退到系统相机。
- **选图**：点「选择多张图片」从相册多选，同样只入队不解析。
- **先存后提交，首页只留一个按钮**：拍照/选图只把照片**保存到下方列表等待**，绝不立即解析；可连续拍、分次选，累积到同一批。**一次最多排队 15 张**（超出忽略并提示）。全部准备好后点唯一的「🚀 开始识别并入库」才统一提交
- 点提交后自动完成全流程：
  1. 逐张上传 → 调 `detect-page` 由 AI 读出图片上**印刷的页码** → 写入页码表 `vw_scan_batches.page_no`
  2. 按真实页码升序排列
  3. **查词表按页码判断「前期是否已录入」**：`vw_words` 里该 `page_no` 已有词条 → 该图标注「◷ 前期已录入（跳过）」，本次不重复扫描入库
  4. 对未录入的页按页码顺序调 `scan-page` 拆解入库，跨页半截词上下文按序传递
- **前期已录入的页**：在下方图片清单里显示灰色「前期已录入」标记与说明，本次自动跳过；如需强制重扫，改一下缩略图上的页码即可
- **手动校正路径（备用）**：「仅识别页码」先识别并在缩略图上改页码 → 确认无误后再点「按页码顺序扫描入库」
- **已彻底移除错误做法**：不再用「上次最大页码 + 拍照顺序累加」分配页码，也不从文件名猜页码
- 队列状态：待识别 → 上传 → 识别页码 → （◷ 前期已录入跳过）/ 解析入库 → 完成/失败；失败点状态可重试
- **一图一页**（不要一次拍对开两页，否则页码会乱）

### 数据库初始化状态（2026-11-16）
- 已清空所有业务表（`vw_words/vw_senses/vw_examples/vw_scan_batches` 均 0 行，自增 ID 已重置），并删除 Storage 桶内全部测试图片；仅保留 `vw_books` 里一条 `victor` 空书供正式录入
- 最大页码权威来源是 `vw_scan_batches` 表；表为空时弹框/进度显示「从第 1 页开始」，不会残留旧页码
- 后续不再向正式表写入任何测试数据

### 跨页单词如何处理（重点：页码主导 + partial 补全）

**页码 ↔ 单词的对应关系**：有，且是显式存储的。`vw_words` 每条记录都有 `page_no` 字段，直接绑定「这个单词来自哪一页」；查 `SELECT page_no, headword FROM vw_words` 即可拿到全部对应关系。页码表 `vw_scan_batches.page_no` 则记录「每一张扫描图是哪一页」，两者用同一页码口径。初始化前抽样验证过对应关系（P1→abandon/ability/able…，P3→absence/absorb/abstract…，P123→daughter/dawn/day…），现已随初始化清空，正式录入后会重新建立。

去重主键是 **(book_id, headword, page_no)**——同一单词在不同页各占一条，重扫同一页则合并。规则如下：

1. **页码定连续**：页码是印刷的确定性信号，比让 AI 猜 boundary 更可靠。实测发现 AI 对页首/页尾承接的判断会误判，故改以页码为准，AI 的 `boundary` 仅作参考。
2. **页尾半截词暂存（partial）**：某词在页尾被截断、义项会在下一页继续时，AI 给它标 `partial=true`，**先录入并标记「待补全」**（不是丢弃——万一你不扫下一页，数据仍在）。
3. **下一页自动补全**：扫下一页时带上 `nextContext = {page_no, partial_words}`；若识别到与上一页半截词同名的词，则把它的义项/例句**合并到上一页那条记录**，并把 `partial` 置为 `false`。
4. **重扫去重**：同一页重扫时，按 `(book, headword, page_no)` upsert，义项按 `词性+义词编号` 合并、例句按英文归一化去重，**不产生重复词条**（对应"重复单词舍弃"）。
5. 队列卡片和词库会提示「待补全」「已补全 N 个半截词」。

> 已用新版本单词书的三张真实扫描图端到端验证：① 页码入库+partial 标记（第1页 abolish 正确标半截）；② 同页重扫合并去重（合并 9 义项/23 例句，无翻倍）；③ partial 补全（abolish 从 true→false、义例句并入原页）。生产数据 4345 条未受影响。

> 说明：AI 每次解析存在轻微波动（同一页两次可能识别出 7 / 9 个词），去重机制保证"识别出的相同内容不重复入库"，但不保证每次识别出的词集完全一致。

### 高考链接栏目跳过（不解析、不入库）
- 维克多等词典页里有独立的**「高考链接」方块**（蓝色/带边框底纹，标题"高考链接"，内含编号 1.2.3. 的真题、带 `_____` 填空、出处如"2020全国Ⅱ卷""2019全国Ⅰ卷(改错)"）。这部分是高考真题板块，**不属于词条本身，整块跳过**，不作为词条/义项/例句入库。
- 双层保障：① `scan-page` 的 `SYSTEM_PROMPT` 明确要求整块忽略；② 服务端 `isGaokaoLinkItem()` 兜底——出处含全国卷/新高考/改错/高考链接，或题干带连续下划线且带题号的例句直接丢弃。
- **不误伤**普通例句：词条例句后的省份/教材出处（"2011陕西""人教③-5""译林新选必①-2"）照常保留。已用 8 组样例验证（4 类高考题拦截 / 4 类正常例句保留，8/8 通过）。

### v2 解析精准度升级（2026-11-17）
喂图 21 页（P27–P47）+ 书前 2 页官方图例，把整书版式规则吃透后重写了 `scan-page` 提示词。完整规则见 `版式规则手册.md`，决策见 `改进方案_v2.md`。要点：
- **版式顺序**：每页左右两列，先左后右、字母序；页眉词≠页首词；页首无词头的句子是上页词的跨页延续。
- **身份符号**：`*`课标外 / `⊕`增补(实心圆内十字) / `⊖`删减(实心圆内一横) / 灰底派生合成词。⊕ 与 ⊖ 都是实心圆，靠圆内十字/一横区分。
- **词频 Rⁿ**：音标后"柱状图图标 + R+数字(1~5)"，存 `freq_level`。
- **两层编号**：大实心圆 ①②③=义项 `sense_no`（深色=高频 `sense_freq=1`、浅色=低频=2）；小空心圆=义项内搭配 `kind=phrase`。
- **■词性分节**：一词多词性时每段 ■ 开新 pos；**▶/▼ 派生词**独立成词条并回填 `parent_word_id` 关联母词。
- **蓝底标签框**：`辨`(辨析)/`注`(小贴士)/`同`(词族) 存入新表 `vw_notes`，不塞进例句；`高考链接`仍整块跳过。
- **义项级英文释义**存 `sense.english_def`。
- 数据库增量迁移脚本：`supabase/migration_v2_accuracy.sql`（ADD COLUMN + 新表 + 视图，不动已有数据）。

### 演示模式
未配置 Supabase 时默认演示模式，用内置 P123 样例跑通流程，数据存本机 localStorage。当前线上已预置 Supabase 配置，打开即在**在线模式**。

---

## 三、接入真实 Supabase（在线模式）

### 第 1 步：创建 Supabase 项目

到 [supabase.com](https://supabase.com) 免费创建项目。记下两样东西（Settings → API）：

- **Project URL**：形如 `https://xxxx.supabase.co`
- **anon public key**：以 `eyJ...` 开头的公钥

> 注意：只用 anon 公钥，**不要把 service_role 密钥填到前端**。

### 第 2 步：执行建表脚本

在 Supabase 控制台左侧 **SQL Editor** → New query，把 `supabase/schema.sql` 全文粘贴进去执行。会创建：

- `books` / `words` / `senses` / `examples` / `scan_batches` 五张表 + `v_vocab` 视图
- 行级安全（RLS）：查询只读开放，写入由服务端 service_role 完成
- `pages` 图片存储桶（公开读、允许匿名上传）

执行后到 **Table Editor** 确认表都建好了；到 **Storage** 确认有 `pages` 桶。

### 第 3 步：部署扫描拆解函数

需要本机安装 [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) 并登录：

```bash
supabase login
supabase link --project-ref <你的项目 ref>     # ref 在 Settings → General 里
```

配置密钥（**只存在服务端**）。代码默认已设为**火山方舟 · 豆包 Seed 2.1 Lite**（国内直连、识图稳、成本低），只需配一个密钥：

```bash
supabase secrets set ARK_API_KEY=你的火山方舟APIKey
# 若控制台给的是接入点 ID（ep-xxxxxx），再指定模型：
# supabase secrets set AI_MODEL=ep-xxxxxx
```

想换成通义千问 / OpenAI 也可，改 `AI_BASE_URL` 和 `AI_MODEL` 即可（详见 `supabase/functions/scan-page/说明.txt`）。

部署函数（两个都要）：

```bash
cd supabase
supabase functions deploy detect-page
supabase functions deploy scan-page
# config.toml 已为两个函数设置 verify_jwt=false，anon key 可直接调用
```

部署后在控制台 **Edge Functions** 里能看到 `detect-page` 与 `scan-page`。

> 模型说明：默认豆包 Seed 2.1 Lite 支持图片输入；代码带 JSON 格式降级容错（豆包对 `response_format` 部分支持，会自动去掉该参数重试），无需额外改动。

### 第 4 步：前端切换在线模式

打开页面 → 底部「设置」页：

1. 填 **Supabase Project URL**
2. 填 **anon public key**
3. 填 **书名 book_id**（如 `victor`，同一本书单词去重依据）
4. 关掉「演示模式」开关
5. 点「测试连接」看到"连接成功"→ 点「保存设置」

之后拍照扫描就会走真实流程：图片上传到 `pages` 桶 → 调用 `scan-page` 让 AI 拆解 → 三层数据入库 → 词库页实时查询。

---

## 四、数据流说明

```
[手机连续拍照 / 相册多选 N 张]
   │
   ├─ 阶段① 逐张：上传 Storage: vocab-pages/{book}/{ts}_{file}
   │        └─ [Edge Function: detect-page] AI 读取图片印刷页码
   │              └─ 写入页码表 vw_scan_batches.page_no（供最大页码查询 & 排序）
   │
   ├─ 按识别到的页码升序排列（可人工校正缩略图页码）
   │
   └─ 阶段② 按序逐页：[Edge Function: scan-page]
              │ 1. 把图片交给多模态 AI（豆包）
              │ 2. AI 输出 words → senses → items；页码以阶段①落库值为准并用 AI 复核
              │ 3. service_role 三层写入 vw_words/vw_senses/vw_examples
              │    （按 book_id+headword+page_no 幂等去重；partial 半截词跨页合并）
              │ 4. 更新批次状态 done
   ▼
[词库页] REST 嵌套查询 vw_words + vw_senses + vw_examples，支持搜索
[弹框/进度] 从 vw_scan_batches.MAX(page_no) 读取上次最大页码
```

密钥安全：AI Key 和 service_role 密钥只在 Edge Function 服务端环境变量里，前端只有 anon 公钥。

---

## 五、第一版的边界与后续可扩展点

当前已实现：

- 拍照/选图上传（支持手机后置摄像头，`capture="environment"` 可直接调起相机）
- AI 结构化拆解并入库（沿用验证过的三层数据模型，含音标/词性/义项/例句/出处/用法标签）
- 词库查询 + 搜索（英文单词、中文释义、例句全文）

尚未做（属于背词功能，非本版范围）：

- 复习/记忆算法（艾宾浩斯、间隔重复）
- 用户登录与多端同步（当前查询只读开放，适合个人使用；如需多用户可加 Supabase Auth 并用 `auth.uid()` 收紧 RLS）
- 整本书批量导入（当前一次一页；可加批量上传队列）
- OCR 校对人工干预界面

如需我把 AI 换成国内兼容大模型、加登录、或做批量扫描队列，告诉我即可继续。
