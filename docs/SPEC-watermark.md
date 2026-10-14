# Spec: watermark — 登录后页面动态水印

> 模块 id: `watermark` ｜ 能力地图: [CAPABILITY-MAP.md](./CAPABILITY-MAP.md)
> 需求来源: docs/intent/pailie3-erp.md「防截图」——安卓壳 FLAG_SECURE 已有，本模块补页面水印防**物理拍照**外传

## Objective

所有登录后的页面（含弹窗内的内容）叠加半透明平铺水印：`用户名 + 日期 + 时间（分钟）`。手机拍屏幕的照片上可辨识归属人，形成泄密追溯威慑。与安卓壳 FLAG_SECURE 组成双通道防护：系统级禁截屏 + 页面级水印防拍照。

**验收标准（具体可测）——已满足 ✅ 2026-10-14：**
- [x] 登录后（session 存在）出现全局水印层；登录页不显示（无身份无追溯意义）
- [x] 水印文字含 `用户名 + YYYY-MM-DD HH:mm`，每 60 秒自动刷新时间
- [x] 水印不遮挡、不影响任何交互（`pointer-events: none`）
- [x] modal dialog（`<dialog>` top layer，普通 fixed 层压不住它）打开时其内容区**同样有水印**：`.drawer-content` 内嵌同款水印层
- [x] 水印实现零新增依赖：运行时生成 SVG data-URI 写入 CSS 变量 `--watermark-image`，全局层与 dialog 层共用同一个变量（一处更新、两处生效）
- [x] 水印样式：旋转约 -30°、透明度约 0.08、字号 13px、平铺间距约 200×140，文字色跟随主题深绿
- [x] 客户端 UI 测试：登录前渲染无水印容器；登录后水印变量已设置

## 技术方案（核心一段）

```javascript
function refreshWatermark(username) {
  const now = new Date();
  const text = `${username} ${now.toLocaleDateString('zh-CN')} ${now.toTimeString().slice(0,5)}`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='140'><text x='24' y='120' font-size='13' fill='#176458' fill-opacity='0.5' transform='rotate(-28 24 120)'>${text}</text></svg>`;
  document.documentElement.style.setProperty('--watermark-image', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
}
```
```css
#app[watermarked]::after { content:''; position:fixed; inset:0; z-index:9999; pointer-events:none;
  background-image:var(--watermark-image); background-repeat:repeat; }
.drawer-content::after { /* 同款，absolute 覆盖弹窗内容 */ }
```
登录成功（`acceptSession`）设置 `watermarked` 标记并启动 60s 定时器；退出登录清除标记与定时器。用户名经 `encodeURIComponent` + SVG 文本转义，防注入。

## Commands

```sh
npm test
npx tsc --noEmit
npx vitest run tests/client-ui.test.ts
```

## Project Structure（改动，均为前端单点）

```
src/app/client/app.js        → refreshWatermark() + 登录/退出钩子 + 60s 定时器 + watermarked 状态
src/app/client/index.html    → 根元素绑定 :watermarked；无需每 dialog 改结构（CSS ::after 自动覆盖）
src/app/client/styles.css    → 全局层 + .drawer-content 层两段水印样式
tests/client-ui.test.ts      → 2 项新断言（登录前无 / 登录后有）
```

## Boundaries

- **Always**: 文本过 encodeURIComponent；水印层 pointer-events:none；退出登录清除定时器防泄漏
- **Ask first**: 无（无后端改动、无 schema 改动、无依赖）
- **Never**: 不做"防 DevTools 删除"对抗（目标用户是街坊客户，非技术人员）；不拦截触摸/滚动

## Success Criteria

1. 店长/客户登录后任意页面截图（模拟）可见平铺水印：用户名+时间清晰可辨
2. 打开跟单弹窗、照片弹窗、日历详情弹窗，弹窗内容上同样有水印
3. 水印不影响点击、滚动、表单输入
4. 270+2 项测试全绿，tsc 无错

## Open Questions

（无——时间分钟精度 + 60s 刷新为默认值，可部署后按实际效果调整透明度/密度）
