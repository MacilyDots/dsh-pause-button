/**
 * dsh-pause-button 宿主半：让运行中的会话在「步骤边界」停住，而不是中止。
 *
 * 暂停不是 abort：它在 agent/pre-step 这道 waterfall 上把下一次模型请求挂住，
 * turn 保持打开、已完成的消息与工具结果全部保留；点继续时放行，模型无感知地接着跑。
 *
 * 三个端点由浏览器半调用：status / pause / resume / stop / continue。
 */

import { mountRpcChannel } from './rpc-channel.js'

export const name = 'dsh-pause-button'

/** 宿主依赖：webServer 挂 RPC 通道，connection 提供请求信任判定。 */
export const inject = ['connection', 'webServer']

/** 停止时给模型留的「继续」提示。 */
const CONTINUE_TEXT = '继续'

export function apply(ctx) {
  /**
   * 每个会话的暂停状态。
   * armed：用户已按下暂停，等下一个步骤边界生效。
   * paused：闸门正挂着，turn 没结束。
   * aborted：用户长按硬中止过，下一次问模型「要不要继续」。
   */
  const states = new Map()
  const stateFor = (sessionId) => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = { armed: false, paused: false, aborted: false, release: undefined }
      states.set(sessionId, state)
    }
    return state
  }

  /** agent/status 观测到的运行态，作为 agents 注册表读不到时的兜底。 */
  const observed = new Map()

  const agentsService = () => (typeof ctx.get === 'function' ? ctx.get('agents', false) : undefined)

  const isRunning = (sessionId) => {
    const agents = agentsService()
    const agent = agents?.get?.(sessionId)
    if (agent !== undefined && typeof agent.status === 'string') return agent.status === 'running'
    return observed.get(sessionId) === 'running'
  }

  const releaseGate = (state) => {
    state.armed = false
    if (typeof state.release === 'function') {
      const release = state.release
      state.release = undefined
      release()
    }
  }

  // 步骤边界闸门：turn 打开、下一次模型请求发出之前。
  ctx.on('agent/pre-step', async (payload, next) => {
    const sessionId = payload.agent.id
    observed.set(sessionId, 'running')
    const state = stateFor(sessionId)
    // 新一轮的第一请求：清掉上一次中止的标记，并且不停。
    if (payload.step <= 1) {
      state.aborted = false
      return next()
    }
    if (!state.armed) return next()

    state.armed = false
    state.paused = true
    await new Promise((resolve) => {
      state.release = resolve
      if (payload.signal?.aborted === true) resolve()
      else payload.signal?.addEventListener?.('abort', () => resolve(), { once: true })
    })
    state.release = undefined
    state.paused = false
    return next()
  })

  ctx.on('agent/status', (payload) => {
    const sessionId = payload.agent.id
    observed.set(sessionId, payload.status)
    if (payload.status === 'running') return
    // turn 已经结束：暂停请求作废，别让下一次请求被上一次的意图书住。
    const state = stateFor(sessionId)
    releaseGate(state)
  })

  ctx.on('agent/inbox/inserted', (payload) => {
    // 用户又发了消息：以人的动作为准。暂停直接放行，中止标记也作废——别让一枚
    // 「继续上一轮」按钮在人已经开始新话题之后还挂着。
    const state = stateFor(payload.agent.id)
    state.aborted = false
    if (state.paused) releaseGate(state)
  })

  const handler = async (endpoint, payload, signal) => {
    try {
      const sessionId = payload?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') return rpcError(`${endpoint} requires sessionId:string`)
      const state = stateFor(sessionId)

      switch (endpoint) {
        case 'status':
          return ok({
            running: isRunning(sessionId),
            paused: state.paused,
            armed: state.armed,
            aborted: state.aborted,
          })

        case 'pause': {
          if (!isRunning(sessionId)) return ok({ running: false, paused: false, armed: false, aborted: state.aborted })
          state.armed = true
          return ok({ running: true, paused: state.paused, armed: true, aborted: state.aborted })
        }

        case 'resume': {
          releaseGate(state)
          return ok({ running: isRunning(sessionId), paused: false, armed: false, aborted: state.aborted })
        }

        case 'stop': {
          const controller = ctx.get('sessionController', false)
          if (controller === undefined) return rpcError('会话服务不可用，无法中止')
          controller.cancel({ sessionId })
          state.aborted = true
          releaseGate(state)
          return ok({ running: false, paused: false, armed: false, aborted: true })
        }

        case 'continue': {
          if (isRunning(sessionId)) return rpcError('这一轮还在运行，先暂停再继续')
          const controller = ctx.get('sessionController', false)
          if (controller === undefined) return rpcError('会话服务不可用，无法继续')
          await controller.prompt(
            {
              requestId: `dsh-pause-continue-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: CONTINUE_TEXT }],
            },
            signal,
          )
          state.aborted = false
          return ok({ running: true })
        }

        default:
          return rpcError('unknown endpoint ' + endpoint)
      }
    } catch (error) {
      return rpcError(error instanceof Error ? error.message : String(error))
    }
  }

  mountRpcChannel(ctx, '/dsh-pause-button', handler)
}

function ok(value) {
  return { ok: true, value }
}

function rpcError(message) {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}
