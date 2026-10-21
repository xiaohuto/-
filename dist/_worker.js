const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-6-astra';
const encoder = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function failure(status, message, details = {}) {
  return json({error: {message, ...details}}, status);
}

function safeErrorText(value, secrets, maxLength = 500) {
  if (typeof value !== 'string') return '';
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join('[已隐藏]');
  return text.replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏]')
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/data:image\/[^\s"'<>]+/gi, '[图片数据已隐藏]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[链接已隐藏]')
    .replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function upstreamFailure(response, secrets) {
  // Read only a small JSON error object. Never return HTML, headers, request
  // content or unredacted upstream error text to the browser.
  let data = null;
  if (response.headers.get('Content-Type')?.toLowerCase().includes('application/json')) {
    const reader = response.body?.getReader();
    if (reader) {
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 16384) { await reader.cancel(); break; }
          chunks.push(value);
        }
        if (bytes <= 16384) {
          const merged = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
          data = JSON.parse(new TextDecoder().decode(merged));
        }
      } catch { /* Preserve the HTTP status even if the error body is malformed. */ }
      finally { reader.releaseLock(); }
    }
  } else {
    try { await response.body?.cancel(); } catch {}
  }
  const error = data?.error && typeof data.error === 'object' ? data.error : {};
  const code = safeErrorText(error.code, secrets, 80);
  const detail = safeErrorText(error.message, secrets, 320);
  const requestId = safeErrorText(response.headers.get('x-request-id'), secrets, 100);
  const defaults = {
    400: 'OpenAI 未接受本次请求，请检查错误原因。',
    401: 'OpenAI 身份验证失败，请检查服务端 API 密钥与项目设置。',
    403: 'OpenAI 拒绝了此服务器的请求；仅凭 403 无法确定是模型权限问题。',
    404: 'OpenAI 未找到请求的模型或资源，请核对模型名称与项目访问权限。',
    429: 'OpenAI 限制了本次调用，请根据错误原因检查额度或调用频率。',
  };
  let message = defaults[response.status] || 'OpenAI 服务暂时不可用，请稍后重试。';
  if (code === 'unsupported_country_region_territory')
    message = 'OpenAI 拒绝了当前服务器所在国家或地区的请求，请核对 OpenAI 支持地区及账户访问条件。';
  else if (code === 'model_not_found')
    message = '当前 API 项目无法访问指定模型，请核对模型名称或项目权限。';
  else if (code === 'invalid_api_key')
    message = 'OpenAI API Key 无效或已失效，请更新 Cloudflare 中的 OPENAI_API_KEY。';
  else if (code === 'ip_not_authorized')
    message = '请求服务器的 IP 未获 OpenAI 项目允许，请检查项目的 IP 白名单。';
  else if (['insufficient_quota','credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded'].includes(code))
    message = 'OpenAI API 额度或支出限额不足，请检查 API 账单及项目限额。';
  if (detail) message += ' 上游说明：' + detail;
  if (code) message += ' 错误码：' + code;
  if (requestId) message += ' 请求编号：' + requestId;
  return failure(response.status, message, {
    ...(code ? {code} : {}), ...(requestId ? {request_id:requestId} : {}),
  });
}

function config(env) {
  const apiKey = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  const password = typeof env.REVIEW_PASSWORD === 'string' ? env.REVIEW_PASSWORD : '';
  const model = typeof env.OPENAI_MODEL === 'string' && env.OPENAI_MODEL.trim()
    ? env.OPENAI_MODEL.trim() : DEFAULT_MODEL;
  return {apiKey, password, model};
}

async function matchesSecret(provided, expected) {
  if (!provided || provided.length > 1024) return false;
  const digests = await Promise.all([provided, expected].map(value =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const [left, right] = digests.map(value => new Uint8Array(value));
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function readLimitedJson(request) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_REQUEST_BYTES)
    throw new RangeError('请求总量超过 20 MB，请减少图片后重试。');
  if (!request.body) throw new SyntaxError('请求内容为空。');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RangeError('请求总量超过 20 MB，请减少图片后重试。');
      }
      chunks.push(decoder.decode(value, {stream: true}));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(''));
  } finally {
    reader.releaseLock();
  }
}

function validatedBody(body, model) {
  if (!body || typeof body !== 'object' ||
      typeof body.instructions !== 'string' || body.instructions.length > 50000 ||
      !Array.isArray(body.input) || body.input.length !== 1)
    throw new TypeError('审核请求格式不正确。');
  const message = body.input[0];
  if (message?.role !== 'user' || !Array.isArray(message.content) ||
      message.content.length < 1 || message.content.length > 60)
    throw new TypeError('审核内容格式不正确。');
  let images = 0;
  let textLength = 0;
  const content = message.content.map(item => {
    if (item?.type === 'input_text' && typeof item.text === 'string') {
      textLength += item.text.length;
      if (textLength > 400000) throw new TypeError('文字内容过长，请减少规则或补充说明。');
      return {type: 'input_text', text: item.text};
    }
    if (item?.type === 'input_image' && typeof item.image_url === 'string' &&
        /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.image_url)) {
      images++;
      if (images > 26 || item.image_url.length > 14 * 1024 * 1024)
        throw new TypeError('图片数量或单张大小超过限制。');
      return {type: 'input_image', image_url: item.image_url, detail: 'high'};
    }
    throw new TypeError('仅支持文字及 PNG、JPG、WEBP 图片，不接受外部图片地址。');
  });
  // The upstream destination, model, output budget and storage policy are
  // controlled here. Browser-supplied URLs, credentials or tools are ignored.
  return {
    model,
    store: false,
    instructions: body.instructions,
    input: [{role: 'user', content}],
    max_output_tokens: 12000,
  };
}

async function review(request, env) {
  if (request.method !== 'POST') return failure(405, '请使用 POST 请求。');
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin)
    return failure(403, '仅允许本站页面调用审核接口。');
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
    return failure(415, '请求必须使用 JSON 格式。');
  const {apiKey, password, model} = config(env);
  if (!apiKey) return failure(503, '请在 Cloudflare 项目的 Variables and Secrets 中添加 OPENAI_API_KEY，并重新部署。');
  if (password.length < 12) return failure(503, '请在 Cloudflare 中添加至少 12 位的 REVIEW_PASSWORD 访问口令，并重新部署。');
  let providedPassword = '';
  try { providedPassword = decodeURIComponent(request.headers.get('X-Review-Token') || ''); } catch {}
  if (!await matchesSecret(providedPassword, password))
    return failure(401, '站点访问口令不正确，请在“模型与接口”中重新填写。');
  let body;
  try {
    body = validatedBody(await readLimitedJson(request), model);
  } catch (error) {
    if (error instanceof RangeError) return failure(413, error.message);
    if (error instanceof TypeError) return failure(400, error.message);
    return failure(400, '请求不是有效 JSON。');
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.signal.addEventListener('abort', onAbort, {once: true});
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 230000);
  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Workers supports only manual/follow. Reject redirects below so that
      // Authorization is never forwarded to another destination.
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return failure(502, 'OpenAI 接口返回了异常跳转，已停止请求，请稍后重试。');
    }
    if (!response.ok) {
      return await upstreamFailure(response, [apiKey, password]);
    }
    if (!response.headers.get('Content-Type')?.includes('application/json')) {
      await response.body?.cancel();
      return failure(502, 'OpenAI 未返回有效 JSON，请稍后重试。');
    }
    const data = await response.json();
    if (data.status === 'incomplete' || data.error)
      return failure(502, '模型输出不完整，请减少图片或规则后重试。');
    const outputText = (data.output || [])
      .filter(item => item.type === 'message')
      .flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text')
      .map(item => item.text).join('\n');
    if (!outputText.trim()) return failure(502, '模型未返回审核内容，请重试。');
    return json({status: 'completed', output_text: outputText, model: data.model || model});
  } catch {
    return failure(controller.signal.aborted ? 504 : 502,
      controller.signal.aborted ? '审核请求已停止或超时，请减少图片后重试。' : '暂时无法连接 OpenAI，请稍后重试。');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/status' && request.method === 'GET') {
      const {apiKey, password, model} = config(env);
      return json({service: 'brand-review-cloudflare', version: '20261021-3',
        configured: !!apiKey, accessConfigured: password.length >= 12, model});
    }
    if (path === '/api/review') return review(request, env);
    if (path.startsWith('/api/')) return failure(404, '接口不存在。');
    return env.ASSETS.fetch(request);
  },
};
