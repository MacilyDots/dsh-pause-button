/**
 * dsh-pause-button 浏览器半：把 composer 的发送按钮变成「发送 / 暂停 / 继续」三态单按钮。
 *
 * 原生提交按钮没有替换槽位，所以这里占用紧挨着它的 conversation.input.activity 座：
 * 需要接管时把文档顺序在自己之后的原生按钮隐藏掉，自己渲染一枚尺寸、配色、位置完全一致的按钮；
 * 空闲时不接管任何东西，原生发送按钮照常工作。
 */

/** 长按多久算「立即中止」。太短会把正常点击误判成长按，1 秒留出手指余量。 */
const LONG_PRESS_MS = 1000
/** 长按过程中允许的指针位移，超过就算滑动而不是长按。 */
const LONG_PRESS_SLOP = 8
/** 状态轮询间隔。 */
const POLL_MS = 500
const CHANNEL = '/dsh-pause-button'

/** 与原生 .GRgSLq_primary 逐条对齐的样式，只换类名前缀。 */
const CSS = `
.dshpb_row{flex:none;align-items:center;display:flex}
.dshpb_primary{corner-shape:round;background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;border:none;border-radius:999px;flex:none;place-items:center;width:34px;height:34px;transition:background-color .1s,opacity .15s;display:grid;transform:translateY(-2px);padding:0}
@media (hover:hover){.dshpb_primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}}
.dshpb_primary:disabled{opacity:.4;cursor:default}
.dshpb_row[data-armed="1"] .dshpb_primary{opacity:.55}
.dshpb_row[data-pressing="1"] .dshpb_primary{transform:translateY(-2px) scale(.92)}
`

window.__ModuleLoader__.load({
  id: 'dsh-pause-button',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // 官方 Tooltip：模块表里有 @deepseek-ai/dsh-client-ui-primitives，取不到就退回 title 属性。
    let Tooltip = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      if (primitives !== null && primitives !== undefined && typeof primitives.Tooltip === 'function') Tooltip = primitives.Tooltip
    } catch {
      Tooltip = null
    }

    /** 与原生按钮一致：按下时阻止默认，光标留在输入框里。 */
    function keepEditorFocus(event) {
      event.preventDefault()
    }

    function ensureStyle() {
      if (document.querySelector('style[data-dsh-pause-button]') !== null) return
      const style = document.createElement('style')
      style.dataset.dshPauseButton = '1'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function callRpc(rpc, method, payload) {
      if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') return Promise.resolve(undefined)
      return Promise.resolve(rpc.call(CHANNEL, method, payload))
        .then((result) => (result !== undefined && result !== null && result.ok === true ? result.value : undefined))
        .catch(() => undefined)
    }

    function Icon({ kind }) {
      const common = { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true }
      if (kind === 'pause') {
        return h('svg', common,
          h('rect', { key: 'a', x: 4.6, y: 3, width: 2.5, height: 10, rx: 1.25, fill: 'currentColor' }),
          h('rect', { key: 'b', x: 8.9, y: 3, width: 2.5, height: 10, rx: 1.25, fill: 'currentColor' }))
      }
      if (kind === 'play') {
        return h('svg', common,
          h('path', {
            key: 'p',
            d: 'M5.4 3.3c0-.72.78-1.13 1.35-.75l6.9 4.35a.9.9 0 0 1 0 1.52l-6.9 4.35c-.57.38-1.35-.03-1.35-.75z',
            fill: 'currentColor',
          }))
      }
      // 环形箭头：上一轮被中止，点一下接着做。
      return h('svg', common,
        h('path', {
          key: 'ring',
          d: 'M8 3.2a4.8 4.8 0 1 0 4.42 2.86',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'head',
          d: 'M12.7 2.3v3.7H9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
    }

    /**
     * 隐藏 / 还原「文档顺序在本组件之后」的原生 composer 按钮。
     *
     * 按元素引用记账，而不是每次重新查 DOM：组件返回 null 时 React 会先把节点摘掉再跑
     * effect 清理，那时 root 已脱离文档，`closest()` 找不到 composer 卡片；只有握着手里的
     * 元素引用才能把原生按钮还原回去，否则发送键会一直停在 display:none。
     */
    function createNativeHider() {
      const saved = new Map()
      return {
        hide(root) {
          const card = root?.closest('[data-composer-card]')
          if (card === undefined || card === null) return
          for (const button of card.querySelectorAll('button')) {
            if (root.contains(button)) continue
            if ((root.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue
            if (saved.has(button)) continue
            saved.set(button, button.style.display)
            button.style.display = 'none'
          }
        },
        restore() {
          for (const [button, display] of saved) {
            try {
              button.style.display = display
            } catch {
              /* 节点已不在也可以用旧值还原，这里只防御性兜底 */
            }
          }
          saved.clear()
        },
      }
    }

    function PauseButton({ rpc, sessionId, useInput }) {
      const [state, setState] = useState({ running: false, paused: false, armed: false, aborted: false, reachable: false })
      // 页面里可能存在不止一个 composer 实例（看到过一张只装了一个按钮的空卡片），
      // 只有在「真的带编辑器的正常宽度输入框」里才接管，免得在别处冒出一枚按钮。
      const [eligible, setEligible] = useState(false)
      const draft = useInput((snapshot) => snapshot.draft)
      const phase = useInput((snapshot) => snapshot.phase)
      const rootRef = useRef(null)
      const hiderRef = useRef(null)
      if (hiderRef.current === null) hiderRef.current = createNativeHider()
      const pressTimer = useRef(undefined)
      const longPressed = useRef(false)
      const startPoint = useRef(null)
      const inFlight = useRef(false)
      const [pressing, setPressing] = useState(false)

      const refresh = useCallback(async () => {
        const value = await callRpc(rpc, 'status', { sessionId })
        if (value === undefined) {
          setState((previous) => (previous.reachable ? { ...previous, reachable: false } : previous))
          return
        }
        setState({
          running: value.running === true,
          paused: value.paused === true,
          armed: value.armed === true,
          aborted: value.aborted === true,
          reachable: true,
        })
      }, [rpc, sessionId])

      useEffect(() => { ensureStyle() }, [])

      // 判定自己所在的 composer 卡是不是真的输入框：有编辑器、宽度正常。
      useEffect(() => {
        const root = rootRef.current
        if (root === null) return
        const card = root.closest('[data-composer-card]')
        if (card === null) {
          setEligible(false)
          return
        }
        const measure = () => {
          const editor = card.querySelector('[contenteditable]')
          const width = card.getBoundingClientRect().width
          setEligible(editor !== null && width >= 240)
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(card)
        return () => observer.disconnect()
      }, [])

      useEffect(() => {
        let alive = true
        const tick = async () => {
          if (!alive) return
          await refresh()
        }
        void tick()
        const timer = setInterval(() => { void tick() }, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [refresh])

      const busyPhase = phase === 'adjudicating' || phase === 'submitting' || phase === 'sending'
      let mode = null
      if (state.reachable && !busyPhase) {
        if (state.running) mode = state.paused ? 'resume' : state.armed ? 'cancel' : 'pause'
        else if (state.aborted && (draft ?? '').trim() === '') mode = 'continue'
      }

      // 接管期间隐藏原生按钮；React 重渲染可能换掉节点，用 MutationObserver 追着补。
      useEffect(() => {
        const hider = hiderRef.current
        const root = rootRef.current
        if (!eligible || mode === null || root === null) {
          hider.restore()
          return
        }
        const card = root.closest('[data-composer-card]')
        if (card === null) return
        // 每次进入接管状态先清掉上一次的记账，避免把旧节点残留当成本轮的。
        hider.restore()
        hider.hide(root)
        const observer = new MutationObserver(() => { hider.hide(root) })
        observer.observe(card, { childList: true, subtree: true })
        return () => {
          observer.disconnect()
          hider.restore()
        }
      }, [mode, eligible])

      const action = async () => {
        // 连点保护：一次请求还在飞时不重复发，避免两条「继续」或两次中止。
        if (inFlight.current) return
        inFlight.current = true
        try {
          if (mode === 'pause') {
            setState((previous) => ({ ...previous, armed: true }))
            await callRpc(rpc, 'pause', { sessionId })
          } else if (mode === 'cancel' || mode === 'resume') {
            setState((previous) => ({ ...previous, armed: false, paused: false }))
            await callRpc(rpc, 'resume', { sessionId })
          } else if (mode === 'continue') {
            await callRpc(rpc, 'continue', { sessionId })
          }
          await refresh()
        } finally {
          inFlight.current = false
        }
      }

      const clearPress = () => {
        if (pressTimer.current !== undefined) {
          clearTimeout(pressTimer.current)
          pressTimer.current = undefined
        }
        setPressing(false)
      }

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        longPressed.current = false
        clearPress()
        // 只有运行中才可能「立即中止」；空闲态长按没有意义。
        if (mode !== 'pause' && mode !== 'cancel' && mode !== 'resume') return
        startPoint.current = { x: event.clientX, y: event.clientY }
        setPressing(true)
        pressTimer.current = setTimeout(() => {
          pressTimer.current = undefined
          longPressed.current = true
          setPressing(false)
          if (inFlight.current) return
          inFlight.current = true
          void (async () => {
            try {
              await callRpc(rpc, 'stop', { sessionId })
              await refresh()
            } finally {
              inFlight.current = false
            }
          })()
        }, LONG_PRESS_MS)
      }

      // 手指/鼠标滑开就取消长按，避免「按住拖一下」被当成中止。
      const onPointerMove = (event) => {
        if (pressTimer.current === undefined) return
        const start = startPoint.current
        if (start === null) return
        if (Math.abs(event.clientX - start.x) > LONG_PRESS_SLOP || Math.abs(event.clientY - start.y) > LONG_PRESS_SLOP) {
          clearPress()
        }
      }

      const onClick = () => {
        clearPress()
        if (longPressed.current) {
          longPressed.current = false
          return
        }
        void action()
      }

      useEffect(() => () => clearPress(), [])

      // 始终保留一个节点，资格判定才有东西可量；不接管时它完全不可见。
      if (mode === null || !eligible) {
        return h('div', { ref: rootRef, style: { display: 'none' } })
      }

      const glyph = mode === 'pause' || mode === 'cancel' ? 'pause' : mode === 'resume' ? 'play' : 'continue'
      const label = mode === 'pause'
        ? '暂停'
        : mode === 'cancel'
          ? '等待当前步骤结束，再点取消暂停'
          : mode === 'resume'
            ? '继续'
            : '继续上一轮'
      const tooltipLabel = mode === 'pause' ? '暂停（长按立即中止）' : label
      const busy = inFlight.current
      const buttonProps = {
        type: 'button',
        className: 'dshpb_primary',
        'aria-label': label,
        'aria-busy': busy ? true : undefined,
        disabled: busy,
        // 原生按钮在 onMouseDown 里阻止默认，点完按钮光标仍留在输入框。
        onMouseDown: keepEditorFocus,
        onPointerDown,
        onPointerMove,
        onPointerUp: clearPress,
        onPointerLeave: clearPress,
        onPointerCancel: clearPress,
        onClick,
      }
      // 没有官方 Tooltip 时才用浏览器默认提示，避免两层提示叠在一起。
      const button = h('button', Tooltip === null ? { ...buttonProps, title: tooltipLabel } : buttonProps,
        h(Icon, { kind: glyph }))
      return h('div', {
        ref: rootRef,
        className: 'dshpb_row',
        'data-dsh-pause-button': '1',
        'data-armed': mode === 'cancel' ? '1' : undefined,
        'data-pressing': pressing ? '1' : undefined,
      },
      Tooltip === null
        ? button
        : h(Tooltip, { label: tooltipLabel, side: 'top', delayMs: 500, portal: true, disabled: busy }, button))
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        const rpc = ctx.connection?.rpc
        const Bound = (props) => h(PauseButton, { ...props, rpc })
        ctx.slots.inject('conversation.input.activity', () => ctx.slots.register(
          { name: 'conversation.input.activity' },
          Bound,
        ))
      },
    }
  },
})
