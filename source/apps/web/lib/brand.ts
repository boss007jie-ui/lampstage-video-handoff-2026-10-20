/**
 * 全站品牌 + 文案中心。修改文案只在这一处，所有页面 / API / SEO 自动跟随。
 *
 * 设计原则：
 * - 中英两语对照，结构完全一致
 * - 任何要展示给用户的字符串都走 t(key, lang) 这一个入口
 * - 不引入 i18n 包（react-i18next / next-intl 都太重）
 *   ——MVP 双语只需要一份字典 + 一个上下文 hook
 */

export const BRAND = {
  cn: "创境",
  en: "Lampstage",
  domain: "lampstage.com",
  email: "hello@lampstage.com",
  wechat: "lampstage",
  wechatQr: "/contact/wechat-qr.png",
} as const;

export type Lang = "zh" | "en";

export const SUPPORTED_LANGS: Lang[] = ["zh", "en"];

export const DEFAULT_LANG: Lang = "zh";

/**
 * 把浏览器 navigator.language（如 "zh-CN" / "en-US" / "ja-JP"）映射到我们的两语之一。
 * 中文系（zh-*）→ "zh"；其他全部 → "en"。
 */
export function detectLangFromBrowser(navLang: string | undefined): Lang {
  if (!navLang) return DEFAULT_LANG;
  return navLang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/**
 * 字典：左侧 key 为代码用的稳定 ID，右侧两语为展示文案。
 * 所有页面只用 key + t(lang, key)。
 */
type Dict = Record<Lang, string>;

const D = {
  gallery_headline_first: { zh: "给每个想法，", en: "A good stage." },
  gallery_headline_second: { zh: "一个好舞台。", en: "For every idea." },
  gallery_intro: { zh: "用 WorkBuddy 连接图片、视频与商品内容创作，把灵感带进你的工作流。", en: "Connect image, video and product content creation with WorkBuddy. Bring your ideas into your workflow." },
  gallery_connect: { zh: "连接 WorkBuddy", en: "Connect WorkBuddy" },
  gallery_guide: { zh: "接入指南", en: "Integration guide" },
  gallery_read_guide: { zh: "查看接入指南", en: "Explore the guide" },
  gallery_label: { zh: "创作示意", en: "Creative study" },
  gallery_images: { zh: "图片创作", en: "Image creation" },
  gallery_product: { zh: "商品场景", en: "Product scenes" },
  gallery_video: { zh: "视频创作", en: "Video creation" },
  gallery_film_label: { zh: "灯具品牌短片", en: "Lighting brand film" },
  gallery_film_alt: { zh: "折褶台灯亮起暖光，照亮暮色中的石台", en: "A pleated table lamp casting warm light onto travertine at dusk" },
  gallery_bottle_alt: { zh: "琥珀色玻璃瓶置于石台上，橄榄枝与午后光影围绕", en: "An amber glass bottle on travertine, framed by olive branches and afternoon light" },
  gallery_lamp_alt: { zh: "奶油白折褶台灯与暖色石材，在自然日光中呈现", en: "An ivory pleated table lamp on warm stone in natural sunlight" },
  gallery_linen_alt: { zh: "柔和日光下，亚麻织物舒展的褶皱与纹理", en: "Soft daylight across the folds and texture of ivory linen" },
  gallery_view_image: { zh: "查看图片创作示意", en: "View the image study" },
  gallery_view_product: { zh: "查看商品场景示意", en: "View the product scene" },
  gallery_play_video: { zh: "观看 8 秒灯具品牌短片", en: "Watch the 8-second lamp film" },
  gallery_close: { zh: "关闭预览", en: "Close preview" },
  gallery_motion_note: { zh: "点亮一盏灯 · 8 秒品牌短片", en: "A light comes on · An 8-second brand film" },
  gallery_motion_description: { zh: "从日光里的产品形态，到点亮时的细节，再到暮色中的暖光氛围。", en: "From the lamp’s form in daylight, to the moment it lights up, to a warm glow at dusk." },
  gallery_detail_note: { zh: "围绕材质、构图与自然光的视觉探索。", en: "An exploration of material, composition and natural light." },
  gallery_next_title: { zh: "把创作，接入你的日常。", en: "Make creativity part of your everyday." },
  gallery_next_body: { zh: "创建 API 密钥，连接 WorkBuddy，将图片、视频与商品内容能力融入你的产品与业务流程。", en: "Create an API key, connect WorkBuddy, and bring image, video and product content into your everyday workflows." },
  gallery_footer: { zh: "让想法，有一个好舞台。", en: "A good stage for every idea." },
  login_subtitle: {"zh": "登录后创建个人 API 密钥，连接 WorkBuddy 专家。", "en": "Sign in to create a personal API key and connect your WorkBuddy Expert."},
  footer_privacy: {"zh": "隐私政策", "en": "Privacy"},
  footer_terms: {"zh": "用户协议", "en": "Terms"},
  sample_note: {"zh": "示例用于展示内容方向，实际结果取决于上传素材、任务目标与模型状态。", "en": "Examples illustrate content directions. Results depend on your assets, task goal and model state."},
  sample_label: {"zh": "场景示例", "en": "Scene example"},
  scene_living: {"zh": "客厅", "en": "Living room"},
  scene_dining: {"zh": "餐厅", "en": "Dining room"},
  scene_reading: {"zh": "阅读角", "en": "Reading corner"},
  scene_bedroom: {"zh": "卧室", "en": "Bedroom"},
  scene_hotel: {"zh": "酒店", "en": "Hotel"},
  home_prepare_title: {"zh": "一份清晰的素材，是好的开始。", "en": "Start with a clear source asset."},
  home_prepare_body: {"zh": "创建个人 API Key，确认接入目标，让 WorkBuddy Expert 通过版本化 API 执行你的内容任务。", "en": "Create a personal API key, define the integration goal, and let the WorkBuddy Expert run content tasks through the versioned API."},
  home_prepare_link: {"zh": "查看素材要求", "en": "Asset guidelines"},
  home_bottom_title: {"zh": "下一次任务，从一条可复用的 API 工作流开始。", "en": "Start your next task with a reusable API workflow."},
  home_bottom_body: {"zh": "创建密钥、连接 WorkBuddy Expert，并通过 API 追踪任务结果。", "en": "Create a key, connect your WorkBuddy Expert and track task results through the API."},
  home_contact: {"zh": "咨询 API 与工作流接入", "en": "Discuss API and workflow access"},
  cases_intro: {"zh": "浏览内容与视觉方向，再为你自己的工作流开始调用。", "en": "Explore content and visual directions, then start a workflow of your own."},
  cases_all: {"zh": "全部场景", "en": "All scenes"},
  cases_detail: {"zh": "查看示例", "en": "View example"},
  cases_design_note: {"zh": "这是一个内容方向示例，用于展示构图与氛围。它不是你的任务生成结果。", "en": "This example illustrates composition and mood. It is not a generated result for your task."},
  cases_check_title: {"zh": "生成结果后，建议核对", "en": "When reviewing your results"},
  cases_check_body: {"zh": "主体细节、比例、颜色、画面文字、动作与任务要求。", "en": "Check subject details, proportions, color, text, motion and task requirements."},
  // SEO / 元数据
  meta_title: {"zh": "Lampstage 创境 · 给每个想法，一个好舞台", "en": "Lampstage · A good stage for every idea"},
  meta_desc: {"zh": "用 WorkBuddy 连接图片、视频与商品内容创作。创建个人 API 密钥，把灵感带进可复用的创作工作流。", "en": "Connect image, video and product content creation with WorkBuddy. Create a personal API key and bring ideas into reusable creative workflows."},

  // Nav
  nav_showcase: {"zh": "API 能力", "en": "API capabilities"},
  nav_product: {"zh": "接入流程", "en": "Integration"},
  nav_developers: {"zh": "开发者", "en": "Developers"},
  nav_styles: { zh: "风格", en: "Styles" },
  nav_pricing: { zh: "价格", en: "Pricing" },
  nav_login: { zh: "登录", en: "Sign in" },
  nav_my_works: { zh: "我的作品", en: "My works" },
  nav_credits: { zh: "额度", en: "Credits" },
  nav_help: { zh: "帮助", en: "Help" },
  nav_generate: {"zh": "WorkBuddy 接入", "en": "Connect WorkBuddy"},
  nav_connect: {"zh": "开始接入", "en": "Start integrating"},

  // Hero
  hero_badge: {"zh": "WorkBuddy 专家 · 版本化 API", "en": "WorkBuddy Expert · Versioned API"},
  hero_title: {"zh": "让 WorkBuddy 专家直接调用你的业务能力。", "en": "Give your WorkBuddy Expert a reliable API to run your workflow."},
  hero_subtitle: {"zh": "用一个安全的 API 连接素材、任务和结果。创建密钥、绑定 Expert，即可把可复用的业务流程接入 WorkBuddy。", "en": "Connect assets, jobs and outputs through one secure API. Create a key, bind your Expert and bring reusable business workflows into WorkBuddy."},
  hero_cta_primary: {"zh": "查看 API 接入", "en": "View API integration"},
  hero_cta_secondary: {"zh": "管理 API 密钥", "en": "Manage API keys"},
  hero_meta_speed: { zh: "按实际阶段查看进度", en: "Follow the current stage" },
  hero_meta_count: { zh: "API / Expert / 任务", en: "API / Expert / jobs" },
  hero_meta_styles: { zh: "安全鉴权 · 异步任务", en: "Secure auth · Async jobs" },

  // Stats
  stat_speed_value: { zh: "按阶段", en: "By stage" },
  stat_speed_label: { zh: "出图速度", en: "Output speed" },
  stat_count_value: { zh: "3 张", en: "3 shots" },
  stat_count_label: { zh: "一次预览", en: "Per generation" },
  stat_credits_value: { zh: "20 次", en: "20 free" },
  stat_credits_label: { zh: "新用户免费额度", en: "New-user credits" },

  // Showcase strip
  showcase_eyebrow: {"zh": "API 能力", "en": "API capabilities"},
  showcase_title: {"zh": "让 Expert 连接素材、任务和结果", "en": "Connect assets, jobs and outputs through your Expert"},
  showcase_cta: { zh: "查看接入文档 →", en: "Read the integration guide →" },
  showcase_tag_domestic: { zh: "国内电商版", en: "Marketplace" },
  showcase_tag_brand: { zh: "独立站品牌版", en: "Brand site" },

  // 4 showcase items
  showcase_item_1: { zh: "产品理解", en: "Product understanding" },
  showcase_item_2: { zh: "关键词优化", en: "Keyword optimization" },
  showcase_item_3: { zh: "素材管理", en: "Asset management" },
  showcase_item_4: { zh: "任务查询", en: "Job retrieval" },

  // How it works
  how_title: {"zh": "三步把网站 API 接入 WorkBuddy Expert。", "en": "Connect the API to your WorkBuddy Expert in three steps."},
  how_step1_tag: { zh: "01 创建密钥", en: "01 CREATE KEY" },
  how_step1_title: {"zh": "创建并保存 API Key", "en": "Create and store an API key"},
  how_step1_desc: {"zh": "在账户页生成个人密钥，只在创建时显示一次。", "en": "Create a personal key on the account page. It is shown only once."},
  how_step2_tag: { zh: "02 绑定 Expert", en: "02 BIND EXPERT" },
  how_step2_title: {"zh": "在 WorkBuddy 配置连接器", "en": "Configure the WorkBuddy connector"},
  how_step2_desc: {"zh": "使用 API 地址和 Bearer 密钥，让 Expert 发现能力目录。", "en": "Use the API base URL and Bearer key so the Expert can discover capabilities."},
  how_step3_tag: { zh: "03 执行任务", en: "03 RUN JOBS" },
  how_step3_title: {"zh": "从 Expert 发起并跟踪任务", "en": "Start and track jobs from the Expert"},
  how_step3_desc: {"zh": "上传素材、提交异步任务、查询状态并安全返回结果。", "en": "Upload assets, submit async jobs, poll status and return results safely."},

  // Styles section
  styles_domestic_title: { zh: "国内电商风格", en: "Marketplace style" },
  styles_domestic_desc: {
    zh: "画面更明亮，产品更突出，适合淘宝、天猫、1688 主图和详情场景。",
    en: "Brighter, sharper, product-forward — built for Tmall, 1688 and Taobao listings.",
  },
  styles_brand_title: { zh: "独立站品牌风格", en: "Brand-site style" },
  styles_brand_desc: {
    zh: "更自然、更高级、更生活方式化，适合 Shopify 和外贸官网展示。",
    en: "Natural, premium and lifestyle — built for Shopify and DTC brand sites.",
  },

  // Footer
  footer_tagline: {"zh": "让 WorkBuddy Expert 安全调用你的业务 API。", "en": "Securely connect your business API to WorkBuddy Experts."},

  // Workspace
  ws_title: {"zh": "把素材变成可交付的内容", "en": "Turn source assets into deliverable content"},
  ws_subtitle: {"zh": "上传素材，选择图像、视频或电商内容任务，核对结果后保存并下载。", "en": "Upload an asset, choose an image, video or commerce content task, then review and save the output."},
  ws_mode_chip: {"zh": "AI 内容工作台", "en": "AI content workspace"},
  ws_panel_settings: { zh: "生成设置", en: "Settings" },
  ws_panel_preview: {"zh": "生成结果", "en": "Results"},
  ws_step_upload: { zh: "上传素材", en: "Upload an asset" },
  ws_upload_hint: { zh: "支持图片、视频和参考素材", en: "Images, videos and reference assets" },
  ws_upload_max: { zh: "最大 5MB · JPG / PNG / WEBP", en: "Up to 5 MB · JPG / PNG / WEBP" },
  ws_upload_remove: { zh: "移除", en: "Remove" },
  ws_upload_warn: {
    zh: "提示：背景复杂的工厂实拍图效果可能不稳定，建议使用清晰白底图或透明 PNG。",
    en: "Tip: cluttered factory shots may render unstably. White-background or transparent PNG works best.",
  },
  ws_err_format: { zh: "当前仅支持 JPG、PNG、WEBP 图片。", en: "Only JPG, PNG and WEBP are supported." },
  ws_err_size: { zh: "图片超过 5MB 上限，请压缩后再上传。", en: "Image exceeds the 5 MB limit. Please compress and retry." },
  ws_err_template: { zh: "模板加载失败：", en: "Template load failed:" },
  ws_err_loading: { zh: "加载模板中…", en: "Loading templates…" },

  ws_step_template: { zh: "选择家居场景", en: "Pick a room" },
  ws_step_platform: { zh: "选择平台风格", en: "Pick a style" },
  ws_step_aspect: { zh: "选择图片比例", en: "Pick a ratio" },
  ws_platform_domestic: {"zh": "产品展示", "en": "Product-focused"},
  ws_platform_brand: {"zh": "品牌氛围", "en": "Lifestyle"},
  ws_aspect_1_1: {"zh": "1:1 方图", "en": "1:1 Square"},
  ws_aspect_4_5: { zh: "4:5 详情", en: "4:5 Portrait" },
  ws_aspect_16_9: { zh: "16:9 横图", en: "16:9 Wide" },

  ws_btn_generate: { zh: "场景构思", en: "Plan scenes" },
  ws_btn_generate_loginfirst: { zh: "登录后开始场景构思", en: "Sign in to plan scenes" },
  ws_btn_generating: { zh: "构思中…", en: "Planning…" },
  ws_cost_hint: { zh: "先构思场景，再选择出图数量（每张 1 次额度）", en: "Plan scenes first, then choose how many images (1 credit each)" },

  ws_stage_planning: { zh: "正在构思场景方案…", en: "Planning scenes…" },
  ws_count_title: { zh: "选择出图数量", en: "How many images?" },
  ws_count_hint: { zh: "每张消耗 1 次额度，最适合的空间会优先呈现", en: "1 credit each. The best-fitting space is shown first." },
  ws_count_confirm: { zh: "开始生成", en: "Generate" },
  ws_count_unit: { zh: "张", en: "" },
  ws_expand_settings: { zh: "展开设置", en: "Edit settings" },

  ws_credits_title_signed: {"zh": "剩余额度", "en": "Credits remaining"},
  ws_credits_title_unsigned: { zh: "免费额度（登录后可用）", en: "Free credits (sign in to use)" },
  ws_credits_hint_signed: { zh: "每生成 1 张消耗 1 次", en: "1 credit per image" },
  ws_credits_hint_unsigned: { zh: "登录领取 20 次新人额度", en: "Sign in to claim 20 free credits" },

  ws_preview_disclaimer: {"zh": "发布前请核对结果与源素材、事实和任务要求。", "en": "Review the output against the source, facts and task requirements before publishing."},
  ws_btn_regenerate: { zh: "重新生成", en: "Regenerate" },
  ws_btn_download: { zh: "下载高清图", en: "Download HD" },
  ws_progress_placeholder: { zh: "正在准备生成…", en: "Preparing…" },
  ws_progress_subtext: {"zh": "任务处理期间会显示实际阶段。", "en": "The current processing stage appears here."},

  ws_alert_dryrun: {
    zh: "已记录生成参数：",
    en: "Generation settings recorded:",
  },
  ws_welcome_new: {
    zh: "欢迎，已为你发放 {n} 次免费额度",
    en: "Welcome — {n} free credits have been added.",
  },
  ws_welcome_back: {
    zh: "已登录,剩余额度 {n} 次",
    en: "Signed in. {n} credits remaining.",
  },

  // Generation pipeline
  ws_stage_analyzing: { zh: "正在分析素材…", en: "Analyzing the asset…" },
  ws_stage_matching: { zh: "正在匹配工作流…", en: "Matching the workflow…" },
  ws_stage_generating: { zh: "正在生成内容…", en: "Generating content…" },
  ws_stage_lighting: { zh: "正在优化光影效果…", en: "Refining the lighting…" },
  ws_stage_finalizing: { zh: "正在准备预览图…", en: "Preparing previews…" },
  ws_eta: {"zh": "生成时间取决于素材和任务状态", "en": "Processing time depends on the image and task status"},

  ws_uploading: { zh: "正在上传…", en: "Uploading…" },
  ws_idle_hint: { zh: "等待上传", en: "Waiting for upload" },
  ws_idle_sub: { zh: "上传一份素材，开始调用 AI 能力", en: "Upload an asset to start calling AI capabilities" },
  ws_idle_hint_uploaded: { zh: "已就绪 · 选好场景后点生成", en: "Ready · pick a scene and generate" },
  ws_err_upload_failed: { zh: "上传失败", en: "Upload failed" },
  ws_err_insufficient: {"zh": "额度不足，请查看本次张数或充值。", "en": "Not enough credits. Adjust the image count or top up."},
  ws_err_generic: { zh: "请求失败", en: "Request failed" },
  ws_failure_label: { zh: "生成失败：", en: "Generation failed: " },
  ws_failure_refunded: {"zh": "额度结算请以交易记录为准。", "en": "Check your transaction history for the credit settlement."},

  // Mismatch warning
  ws_mismatch_title: { zh: "素材类型与模板不匹配", en: "Asset type mismatch" },
  ws_mismatch_body: {
    zh: "该模板更适合「{template}」，当前上传图看起来是「{detected}」。继续生成可能在比例和安装方式上不稳定。",
    en: "This template was made for {template}, but the uploaded image looks like a {detected}. Generations may be inconsistent.",
  },
  ws_mismatch_continue: { zh: "仍要使用该模板", en: "Use this template anyway" },
  ws_mismatch_change: { zh: "返回换模板", en: "Pick another template" },

  // Login modal
  login_title: { zh: "登录或注册", en: "Sign in or sign up" },
  login_title_signin: { zh: "欢迎回来", en: "Welcome back" },
  login_title_register: { zh: "创建账号", en: "Create your account" },
  login_title_forgot: { zh: "通过邮箱验证码登录", en: "Sign in with email code" },
  login_signin_for: { zh: "登录账号：", en: "Signing in as" },
  login_register_for: { zh: "新账号：", en: "Creating account for" },
  login_desc: {
    zh: "新账号注册可获赠 20 次额度，体验 WorkBuddy Expert 的 API 内容能力。",
    en: "New accounts receive 20 credits to try the WorkBuddy Expert API content capabilities.",
  },
  login_label_id: { zh: "邮箱", en: "Email" },
  login_placeholder_id: { zh: "you@example.com", en: "you@example.com" },
  login_btn_continue: { zh: "下一步", en: "Continue" },
  login_btn_checking: { zh: "检查中…", en: "Checking…" },
  login_hint_smart: {
    zh: "新邮箱将引导你创建账号，已注册邮箱直接登录。",
    en: "New emails go to signup, existing ones to sign-in.",
  },

  // Sign in (existing user with password)
  login_label_password: { zh: "密码", en: "Password" },
  login_placeholder_password: { zh: "你的密码", en: "Your password" },
  login_btn_sign_in: { zh: "登录", en: "Sign in" },
  login_btn_signing_in: { zh: "登录中…", en: "Signing in…" },
  login_back_email: { zh: "← 换个邮箱", en: "← Use a different email" },
  login_forgot_password: { zh: "忘记密码？", en: "Forgot password?" },
  login_err_no_password: { zh: "请输入密码", en: "Enter your password." },
  login_err_wrong_password: { zh: "密码错误", en: "Wrong password." },
  login_err_no_account: {
    zh: "该邮箱尚未注册",
    en: "This email isn't registered yet.",
  },

  // Register (new user setting password)
  login_label_set_password: { zh: "设置密码", en: "Set a password" },
  login_placeholder_set_password: {
    zh: "至少 6 位",
    en: "At least 6 characters",
  },
  login_hint_password: {
    zh: "下次登录时使用此密码。",
    en: "You'll use this password to sign in next time.",
  },
  login_btn_send: { zh: "发送验证码", en: "Send code" },
  login_btn_sending: { zh: "发送中…", en: "Sending…" },
  login_btn_register: { zh: "完成注册", en: "Complete sign-up" },
  login_btn_registering: { zh: "注册中…", en: "Creating…" },
  login_err_weak_password: {
    zh: "密码至少 6 位",
    en: "Password must be at least 6 characters.",
  },
  login_err_already_registered: {
    zh: "该邮箱已注册，请直接登录",
    en: "This email is already registered. Sign in instead.",
  },

  // Verification code
  login_label_code: { zh: "6 位验证码", en: "6-digit code" },
  login_sent_to: {
    zh: "已向 {id} 发送验证码，请到邮箱查收（含垃圾邮件）。",
    en: "Code sent to {id}. Check your inbox (and spam).",
  },
  login_dev_code: { zh: "开发环境验证码：", en: "Dev code:" },
  login_btn_verify: { zh: "验证并登录", en: "Verify & sign in" },
  login_btn_verifying: { zh: "验证中…", en: "Verifying…" },
  login_back: { zh: "← 上一步", en: "← Back" },
  login_resend: { zh: "重新发送", en: "Resend" },
  login_resend_in: { zh: "{s}s 后可重发", en: "Resend in {s}s" },

  // Errors (shared)
  login_err_no_id: { zh: "请输入邮箱", en: "Enter an email." },
  login_err_invalid_id: {
    zh: "请输入有效的邮箱地址",
    en: "Enter a valid email address.",
  },
  login_err_rate: {
    zh: "发送过于频繁，请稍后再试",
    en: "Too many requests. Try again in a minute.",
  },
  login_err_send_generic: { zh: "发送失败：", en: "Send failed: " },
  login_err_code_format: {
    zh: "请输入 6 位验证码",
    en: "Enter the 6-digit code.",
  },
  login_err_wrong: { zh: "验证码错误", en: "Wrong code." },
  login_err_expired: {
    zh: "验证码已过期，请重新发送",
    en: "Code expired — request a new one.",
  },
  login_err_no_code: { zh: "尚未发送验证码", en: "Send a code first." },
  login_err_verify_generic: { zh: "验证失败：", en: "Verification failed: " },
  login_err_network: { zh: "网络错误：", en: "Network error: " },
  login_err_service_unavailable: {
    zh: "服务暂时不可用，请稍后再试。",
    en: "Service temporarily unavailable. Please try again shortly.",
  },
  login_close: { zh: "关闭", en: "Close" },
  login_dev_hint: {
    zh: "开发环境：验证码会输出到服务器控制台和返回体里，方便联调。",
    en: "Dev mode: codes print to the server log and response body for testing.",
  },

  // Cases page
  cases_title: { zh: "案例", en: "Cases" },
  cases_body: {
    zh: "正在筛选优质案例。MVP 阶段的真实生成结果将在测试用户验证后陆续公开。",
    en: "Curating real generations from beta users. More public examples are coming soon.",
  },
  cases_back: { zh: "返回首页", en: "Back to home" },

  // My works
  my_title: { zh: "我的作品", en: "My works" },
  my_empty: {
    zh: "还没有任务记录。连接 WorkBuddy 专家后发起第一个任务。",
    en: "No tasks yet. Connect your WorkBuddy Expert to start your first task.",
  },
  my_back: { zh: "查看接入说明", en: "Read integration guide" },
  my_status_completed: { zh: "已完成", en: "Done" },
  my_status_generating: { zh: "生成中", en: "Generating" },
  my_status_failed: { zh: "失败", en: "Failed" },
  my_btn_download: { zh: "下载", en: "Download" },
  my_input_label: { zh: "原图", en: "Source" },

  // Lang toggle
  lang_toggle_to_en: { zh: "EN", en: "EN" },
  lang_toggle_to_zh: { zh: "中", en: "中" },

  // Credits page
  credits_title: { zh: "额度与套餐", en: "Credits & plans" },
  credits_balance_label: { zh: "当前剩余额度", en: "Credits remaining" },
  credits_balance_unit: { zh: "次", en: "credits" },
  credits_history_title: { zh: "交易记录", en: "History" },
  credits_history_empty: { zh: "暂无交易记录", en: "No transactions yet" },
  credits_tx_grant: { zh: "新用户赠送", en: "New-user grant" },
  credits_tx_consume: { zh: "生成消耗", en: "Generation" },
  credits_tx_refund: { zh: "失败退款", en: "Refund" },
  credits_tx_manual: { zh: "运营调整", en: "Manual adjustment" },

  plans_title: { zh: "充值额度包", en: "Top up credit packs" },
  plans_subtitle: {"zh": "选择额度包，在线支付后查看订单状态。每张生成使用 1 次额度。", "en": "Choose a pack and check the online payment status. Each generated image uses 1 credit."},
  plan_free_name: { zh: "免费体验", en: "Free trial" },
  plan_free_quota: {"zh": "20 次额度", "en": "20 credits"},
  plan_free_price: {"zh": "¥0", "en": "CNY 0"},
  plan_free_unit: { zh: "注册即送", en: "On signup" },
  plan_free_desc: {"zh": "新账号注册赠送，用于体验 Expert 发起的 API 任务。", "en": "A new-account grant for API tasks started by the Expert."},
  plan_basic_name: { zh: "体验包", en: "Starter" },
  plan_basic_quota: {"zh": "100 次额度", "en": "100 credits"},
  plan_basic_price: {"zh": "¥30", "en": "CNY 30"},
  plan_basic_unit: {"zh": "¥0.30 / 次额度", "en": "CNY 0.30 / credit"},
  plan_basic_desc: {
    zh: "适合少量 API 任务与初次接入测试。",
    en: "For a small number of API tasks and initial integration testing.",
  },
  plan_business_name: { zh: "标准包", en: "Standard" },
  plan_business_quota: {"zh": "400 次额度", "en": "400 credits"},
  plan_business_price: {"zh": "¥99", "en": "CNY 99"},
  plan_business_unit: {"zh": "约 ¥0.25 / 次额度", "en": "About CNY 0.25 / credit"},
  plan_business_desc: {
    zh: "适合持续通过 Expert 发起内容任务。",
    en: "For ongoing content tasks through your Expert.",
  },
  plan_factory_name: { zh: "大包", en: "Bulk" },
  plan_factory_quota: {"zh": "1500 次额度", "en": "1500 credits"},
  plan_factory_price: {"zh": "¥299", "en": "CNY 299"},
  plan_factory_unit: {"zh": "约 ¥0.20 / 次额度", "en": "About CNY 0.20 / credit"},
  plan_factory_desc: {
    zh: "适合更多 API 任务，单次额度价格更低。",
    en: "For more API tasks, with a lower price per credit.",
  },
  plan_btn_contact: {"zh": "选择额度包", "en": "Choose pack"},
  plan_btn_active: { zh: "已激活", en: "Active" },

  // Lead capture modal
  lead_title: {"zh": "商家咨询", "en": "Talk to us"},
  lead_subtitle: {"zh": "告诉我们你的商品类型、目标市场和场景需求。", "en": "Tell us about your product, target market and scene requirements."},
  lead_label_name: { zh: "称呼（可选）", en: "Name (optional)" },
  lead_scan_title: { zh: "扫码直接加客服", en: "Scan to add support" },
  lead_scan_desc: {"zh": "使用项目客服二维码，咨询素材和使用问题。", "en": "Use the support QR code for image and usage questions."},
  lead_wechat_id: { zh: "微信号", en: "WeChat ID" },
  lead_or_leave: { zh: "或留下联系方式", en: "or leave your contact" },
  lead_label_wechat: { zh: "微信号", en: "WeChat" },
  lead_label_phone: { zh: "手机号", en: "Phone" },
  lead_label_message: { zh: "需求描述（可选）", en: "Message (optional)" },
  lead_placeholder_message: {
    zh: "例如：我有 50 个 SKU，想批量生成图片和商品文案。",
    en: "E.g. I have 50 SKUs and need batch images and product copy.",
  },
  lead_btn_submit: { zh: "提交", en: "Submit" },
  lead_btn_submitting: { zh: "提交中…", en: "Submitting…" },
  lead_err_need_contact: {
    zh: "请至少填写微信号或手机号",
    en: "Please enter WeChat or phone.",
  },
  lead_err_generic: { zh: "提交未成功，请稍后重试或扫码咨询。", en: "Your enquiry could not be sent. Please retry or contact us using the QR code." },
  lead_success_title: {"zh": "已收到你的咨询", "en": "Your message has been received"},
  lead_success_body: {"zh": "联系方式和需求已提交。你也可以使用客服二维码咨询。", "en": "Your contact details and message were submitted. You can also use the support QR code."},
  lead_success_close: { zh: "好的", en: "OK" },

  // Quota exhausted modal (workspace -> 409)
  quota_title: {"zh": "本次生成额度不足", "en": "Not enough credits"},
  quota_subtitle: {"zh": "查看本次出图数量，或选择 100、400、1500 次额度包。", "en": "Check the image count or choose a pack of 100, 400 or 1500 credits."},
  quota_btn_topup: { zh: "去额度页查看套餐", en: "View plans" },
  quota_btn_close: { zh: "稍后再说", en: "Maybe later" },

  // Scene selector tabs
  ws_step_scene: { zh: "选择场景方案", en: "Pick a scene" },
  ws_tab_recommended: {"zh": "智能推荐", "en": "Suggestions"},
  ws_tab_template: {"zh": "快捷模板", "en": "Templates"},
  ws_tab_custom: {"zh": "自由描述", "en": "Describe"},

  ws_recommend_need_upload: {
    zh: "先上传一份素材，再查看围绕任务构思的内容方向。",
    en: "Upload an asset to explore content directions for your task.",
  },
  ws_recommend_uploading: {
    zh: "正在准备上传…",
    en: "Preparing upload…",
  },
  ws_recommend_thinking: {
    zh: "AI 正在分析素材，给出内容建议",
    en: "AI is analyzing your asset and crafting content suggestions",
  },
  ws_recommend_thinking_hint: {"zh": "请等待场景建议返回", "en": "Waiting for scene suggestions"},
  ws_recommend_error: {
    zh: "推荐失败",
    en: "Suggestions failed",
  },
  ws_recommend_retry: { zh: "重试", en: "Retry" },
  ws_recommend_empty: {
    zh: "暂无推荐结果",
    en: "No suggestions yet",
  },

  ws_custom_placeholder: {
    zh: "用一两句话描述你想要的场景。例如：温馨北欧客厅，浅色沙发，落地窗，傍晚柔光。",
    en: "Describe the scene in 1–2 sentences. e.g. Cozy Nordic living room, light sofa, large window, soft evening light.",
  },
  ws_custom_tags_hint: {
    zh: "点击下方标签快速插入风格关键词：",
    en: "Tap a tag to insert it:",
  },

  ws_recommend_thumb_hover: { zh: "悬停预览", en: "Hover to preview" },
  ws_recommend_thumb_loading: { zh: "渲染中…", en: "Rendering…" },

  ws_err_pick_scene: {
    zh: "请先选择一个推荐场景",
    en: "Pick a recommended scene first.",
  },
  ws_err_pick_template: {
    zh: "请先选择一个模板",
    en: "Pick a template first.",
  },
  ws_err_need_prompt: {
    zh: "请先描述你想要的场景",
    en: "Describe the scene first.",
  },
} satisfies Record<string, Dict>;

export type DictKey = keyof typeof D;

export function t(lang: Lang, key: DictKey, vars?: Record<string, string | number>): string {
  const raw = D[key][lang] ?? D[key][DEFAULT_LANG] ?? key;
  if (!vars) return raw;
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
    raw,
  );
}
