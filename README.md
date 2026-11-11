# dsh-pause-button

把 DeepSeek Harness 的发送按钮变成「发送 / 暂停 / 继续」一个按钮：运行中点一下停在下一个步骤边界，再点一下从原处继续，而不是直接中止这一轮。

## 它做什么

| 状态 | 按钮 | 点一下 |
| --- | --- | --- |
| 空闲 | ↑ 发送（原生，不动） | 原生发送 |
| 运行中 | ⏸ | **暂停**：当前这一步跑完就停住，不再发起下一次模型请求 |
| 已请求暂停、还没到边界 | ⏸（半透明） | 取消暂停 |
| 已暂停 | ▶ | **继续**：原地放行，上下文完整，模型无感知 |
| 上一轮被中止、输入框为空 | ↻ | 发一条「继续」把任务接上 |
| 运行中长按 500ms | — | **立即中止**（原生 stop 语义） |

暂停不是 abort：宿主在 `agent/pre-step` 上把下一次模型请求挂住，turn 保持打开，已完成的消息与工具结果全部保留；继续时放行，同一个 turn 接着往下跑，不会多出一条用户消息。

暂停期间如果用户又发了消息，会自动放行——人的动作优先，不让人对着一个不动的界面等。

## 实现要点

- 宿主半 `index.js`：`agent/pre-step` waterfall 闸门 + `/dsh-pause-button` RPC 通道（`status` / `pause` / `resume` / `stop` / `continue`）。`stop` 走 `sessionController.cancel`，`continue` 走 `sessionController.prompt`。
- 客户端半 `client.js`：占用 composer 里紧挨提交按钮的 `conversation.input.activity` 座；需要接管时按**文档顺序**隐藏自己之后的原生按钮，再渲染一枚样式逐条对齐原生 `.GRgSLq_primary` 的 34×34 圆按钮。空闲时不接管任何东西。
- 原生提交按钮没有替换槽位，所以「一个按钮」是靠接管 + 隐藏实现的；原生按钮的类名是 CSS Module 生成的，DSH 升级后需要复查。

## 与原生按钮的一致性

外观与交互尽量对齐原生提交按钮：尺寸 34×34、圆形、`--dsw-alias-button-info-fill`、`translateY(-2px)`、悬停与禁用态都抄自原生 `.GRgSLq_primary`；Tooltip 用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip`（500ms 延迟、主题样式）；`onMouseDown` 阻止默认以保持输入框焦点；`aria-label` / `aria-busy` / `disabled` 与原生同一套语义。

仍然不同的地方：

- **组件来源不同**：这是插件自己的组件，不是 InputBar 内部那个按钮；位置靠占用 `conversation.input.activity` 座并隐藏原生按钮实现。
- **点击路径不同**：原生走 `keyboard.submit` / `stopAction`；这里走自建 RPC → 宿主 `agent/pre-step` 闸门 / `sessionController.cancel` / `prompt`。
- **语义不同**：原生 stop 是 abort（turn 结束），这里的 ⏸ 是挂起下一次模型请求（turn 不结束）。这是新增行为，不可能是原生的。
- **原生按钮的部分状态不感知**：`cancelDenied` / `promptDenied` 等权限态这里没有对应判断。

## 安装

```bash
# web / headless profile
dsh plugin --profile web add github:MacilyDots/dsh-pause-button
```

桌面端由应用独占管理 profile，用应用内的插件管理器安装这个目录（`install_bundle`），然后重启 DSH。

装完重启 DSH 后生效：客户端半在页面启动时注册，改代码或换版本都需要重启，不支持热更。

## 卸载

```bash
dsh plugin --profile web remove dsh-pause-button
```

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半：闸门、会话状态、RPC 处理器 |
| `client.js` | 客户端半：单按钮、原生按钮接管、状态轮询 |
| `rpc-channel.js` | 在 webServer 上自注册的 connection 风格 RPC 通道 |
| `cordis.patch.yml` | bundle 挂载行 |
| `locale/zh.json` | 插件面板里的标题与说明 |

## 已知边界

- 暂停只活在这次运行里：暂停中退出 DSH，turn 会随进程结束，没有落盘恢复。
- 暂停点只在步骤边界：模型正在流式输出时点暂停，会等这一步写完才停。
- 强制中止后未完成工具的处置由 DSH 原生 `cancel` 决定，本插件不介入。
- 页面里若存在多个 composer 实例，只接管带编辑器、宽度正常的那一个。

## License

MIT
