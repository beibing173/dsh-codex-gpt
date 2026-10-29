/**
 * dsh-codex / 外网连通性检查。
 *
 * 判定标准是「能不能拿到 HTTP 响应」，不是「是否 2xx」：
 *   - 401/403/404/405 都说明链路可达（只是没带凭证/路径不对）；
 *   - DNS 失败、TLS 错误、连接被拒、超时、代理不可用会抛错，记为不可达。
 *
 * 覆盖插件依赖的三条外网链路：
 *   1. api.openai.com        —— `codex` 工具真正调用的 OpenAI API；
 *   2. chatgpt.com           —— 侧边栏卡片的订阅用量接口；
 *   3. auth.openai.com       —— 订阅凭证刷新。
 */
const TARGETS = [
  {
    id: 'openai-api',
    label: 'OpenAI API',
    detail: 'api.openai.com',
    url: 'https://api.openai.com/v1/models',
  },
  {
    id: 'chatgpt-usage',
    label: 'ChatGPT 用量',
    detail: 'chatgpt.com',
    url: 'https://chatgpt.com/favicon.ico',
  },
  {
    id: 'openai-auth',
    label: 'OpenAI 登录',
    detail: 'auth.openai.com',
    url: 'https://auth.openai.com/.well-known/openid-configuration',
  },
]

/** 单个目标探测：任何 HTTP 响应都算可达。 */
async function probe(target, timeoutMs, signal) {
  const startedAt = Date.now()
  try {
    const timeout = AbortSignal.timeout(timeoutMs)
    const composed =
      signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(target.url, {
      method: 'GET',
      headers: { Accept: '*/*' },
      signal: composed,
      redirect: 'manual',
    })
    // 不下载响应体：拿到响应头即说明链路已建立。
    try {
      if (response.body && typeof response.body.cancel === 'function') await response.body.cancel()
    } catch {
      // 取消失败不影响可达性判定
    }
    return {
      id: target.id,
      label: target.label,
      detail: target.detail,
      ok: true,
      status: response.status,
      latencyMs: Date.now() - startedAt,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = error && (error.name === 'TimeoutError' || /aborted|timeout/i.test(message))
    return {
      id: target.id,
      label: target.label,
      detail: target.detail,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: timedOut ? `超时（>${Math.round(timeoutMs / 1000)}s）` : message,
    }
  }
}

/**
 * 并行检查全部外网链路。
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ checkedAt: number, targets: object[], reachable: number, total: number }>}
 */
export async function checkConnectivity(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 8000
  const targets = await Promise.all(TARGETS.map((target) => probe(target, timeoutMs, options.signal)))
  return {
    checkedAt: Date.now(),
    targets,
    reachable: targets.filter((item) => item.ok).length,
    total: targets.length,
  }
}
