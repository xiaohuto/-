import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../web/_worker.js';

const env = {OPENAI_API_KEY: 'test-api-secret', REVIEW_PASSWORD: 'testing-access-2026',
  ASSETS: {fetch: async () => new Response('STATIC')}};
const origin = 'https://review.example';
const validBody = () => ({instructions: '检查图片', model: 'ignored-client-model', store: true,
  input: [{role: 'user', content: [{type: 'input_text', text: '请审核'},
    {type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'low'}]}]});
function request(options = {}) {
  const {path = '/api/review', body = validBody(), headers = {}, method = 'POST'} = options;
  return new Request(origin + path, {method,
    headers: {'Origin': origin, 'Content-Type': 'application/json',
      'X-Review-Token': env.REVIEW_PASSWORD, ...headers},
    ...(method === 'POST' ? {body: typeof body === 'string' ? body : JSON.stringify(body)} : {})});
}
async function withFetch(fake, action) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await action(); } finally { globalThis.fetch = original; }
}

test('status reports configuration without disclosing secrets', async () => {
  const res = await worker.fetch(request({path:'/api/status',method:'GET'}), env);
  assert.equal(res.status,200);
  const text = await res.text();
  assert.ok(!text.includes(env.OPENAI_API_KEY) && !text.includes(env.REVIEW_PASSWORD));
  assert.equal(JSON.parse(text).configured,true);
  assert.equal(JSON.parse(text).accessConfigured,true);
  assert.equal(res.headers.get('Cache-Control'),'no-store');
});

test('unconfigured service fails closed before contacting OpenAI', async () => {
  for(const incomplete of [{}, {OPENAI_API_KEY:'test'}, {...env,REVIEW_PASSWORD:'short'}]) {
    const res = await worker.fetch(request(), incomplete);
    assert.equal(res.status,503);
  }
});

test('wrong/missing/malformed access password is rejected', async () => {
  for(const token of ['', 'incorrect-pass', '%ZZ']) {
    assert.equal((await worker.fetch(request({headers:{'X-Review-Token':token}}),env)).status,401);
  }
});

test('cross-origin and invalid media requests are rejected', async () => {
  assert.equal((await worker.fetch(request({headers:{Origin:'https://other.example'}}),env)).status,403);
  assert.equal((await worker.fetch(request({headers:{'Content-Type':'text/plain'}}),env)).status,415);
  assert.equal((await worker.fetch(request({method:'GET'}),env)).status,405);
  assert.equal((await worker.fetch(request({path:'/api/unknown',method:'GET'}),env)).status,404);
});

test('non-API routes fall back to the Pages asset binding', async () => {
  const res = await worker.fetch(request({path:'/',method:'GET'}),env);
  assert.equal(await res.text(),'STATIC');
});

test('malformed and oversize bodies are rejected', async () => {
  assert.equal((await worker.fetch(request({body:'{broken'}),env)).status,400);
  assert.equal((await worker.fetch(request({headers:{'Content-Length':String(21*1024*1024)}}),env)).status,413);
  const stream = new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array(21*1024*1024)); controller.close();
  }});
  const streamed = new Request(origin+'/api/review', {method:'POST',duplex:'half',body:stream,
    headers:{Origin:origin,'Content-Type':'application/json','X-Review-Token':env.REVIEW_PASSWORD}});
  assert.equal((await worker.fetch(streamed,env)).status,413);
});

test('untrusted image URLs, unsupported roles and excessive images are rejected', async () => {
  const external = validBody(); external.input[0].content[1].image_url = 'https://other.example/image.png';
  assert.equal((await worker.fetch(request({body:external}),env)).status,400);
  const role = validBody(); role.input[0].role = 'system';
  assert.equal((await worker.fetch(request({body:role}),env)).status,400);
  const many = validBody(); many.input[0].content = Array(27).fill(many.input[0].content[1]);
  assert.equal((await worker.fetch(request({body:many}),env)).status,400);
});

test('valid image request uses server credentials, fixed destination and bounded schema', async () => {
  let sent;
  const res = await withFetch(async (url, options) => {
    sent={url,options,body:JSON.parse(options.body)};
    return Response.json({status:'completed',model:'server-vision',
      output:[{type:'message',content:[{type:'output_text',text:'审核通过测试'}]}]});
  },() => worker.fetch(request({body:{...validBody(),endpoint:'https://attacker.example',
    tools:[{type:'web_search'}]}}),{...env,OPENAI_MODEL:'server-vision'}));
  assert.equal(res.status,200);
  assert.equal(sent.url,'https://api.openai.com/v1/responses');
  assert.equal(sent.options.headers.Authorization,'Bearer '+env.OPENAI_API_KEY);
  assert.equal(sent.options.redirect,'manual');
  assert.equal(sent.body.model,'server-vision');
  assert.equal(sent.body.store,false);
  assert.equal(sent.body.max_output_tokens,12000);
  assert.equal(sent.body.tools,undefined);
  assert.equal(sent.body.endpoint,undefined);
  assert.equal(sent.body.input[0].content[1].detail,'high');
  assert.equal((await res.json()).output_text,'审核通过测试');
});

test('encoded non-ASCII access password works', async () => {
  const password='仅本团队使用的审核口令2026';
  const res=await withFetch(async()=>Response.json({output:[{type:'message',
    content:[{type:'output_text',text:'OK'}]}]}),()=>worker.fetch(
      request({headers:{'X-Review-Token':encodeURIComponent(password)}}),
      {...env,REVIEW_PASSWORD:password}));
  assert.equal(res.status,200);
});

test('upstream redirects are rejected without forwarding credentials or redirect targets', async () => {
  for (const status of [301,302,303,307,308]) {
    let calls = 0;
    const res = await withFetch(async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.redirect, 'manual');
      return new Response(null, {status, headers:{Location:'https://other.example/private'}});
    }, () => worker.fetch(request(), env));
    assert.equal(res.status, 502);
    assert.equal(calls, 1);
    const text = await res.text();
    assert.ok(text.includes('异常跳转'));
    assert.ok(!text.includes(env.OPENAI_API_KEY) && !text.includes('other.example'));
  }
});

test('upstream errors are actionable and never echo upstream sensitive content', async () => {
  for(const status of [400,401,403,404,429,500]) {
    const res=await withFetch(async()=>Response.json({error:{message:env.OPENAI_API_KEY}},{status}),
      ()=>worker.fetch(request(),env));
    assert.equal(res.status,status);
    assert.ok(!(await res.text()).includes(env.OPENAI_API_KEY));
  }
});

test('incomplete, non-JSON and network errors never return a valid report', async () => {
  for(const fake of [
    async()=>Response.json({status:'incomplete',output:[]}),
    async()=>new Response('<html>bad</html>',{headers:{'Content-Type':'text/html'}}),
    async()=>{throw Error('connection failed');},
  ]) {
    assert.equal((await withFetch(fake,()=>worker.fetch(request(),env))).status,502);
  }
});

test('403 preserves specific region rejection and request ID instead of claiming model permission', async () => {
  const res = await withFetch(async () => Response.json({error:{
    code:'unsupported_country_region_territory', type:'request_forbidden',
    message:'Country, region, or territory not supported.'}},
    {status:403, headers:{'x-request-id':'req_test_region'}}), () => worker.fetch(request(),env));
  const data = await res.json();
  assert.equal(res.status,403);
  assert.equal(data.error.code,'unsupported_country_region_territory');
  assert.equal(data.error.request_id,'req_test_region');
  assert.ok(data.error.message.includes('国家或地区'));
  assert.ok(!data.error.message.includes('无权使用此模型'));
});

test('403 model rejection keeps the actual model code', async () => {
  const res = await withFetch(async () => Response.json({error:{code:'model_not_found',
    message:'The requested model is not available.'}},{status:403}), () => worker.fetch(request(),env));
  const data = await res.json();
  assert.equal(data.error.code,'model_not_found');
  assert.ok(data.error.message.includes('指定模型'));
});

test('error details redact credentials and unsafe content in every displayed field', async () => {
  const res = await withFetch(async () => Response.json({error:{
    code:env.OPENAI_API_KEY,message:`${env.REVIEW_PASSWORD} ${env.OPENAI_API_KEY} sk-placeholder-long-token Bearer raw-token <script>boom</script> https://private.example/path?token=x data:image/png;base64,aGVsbG8=`}},
    {status:403,headers:{'x-request-id':env.REVIEW_PASSWORD}}), () => worker.fetch(request(),env));
  const text = await res.text();
  for (const secret of [env.REVIEW_PASSWORD,env.OPENAI_API_KEY,'sk-placeholder','raw-token','<script>','private.example','aGVsbG8='])
    assert.ok(!text.includes(secret),secret);
});

test('HTML, invalid and excessive upstream errors keep 403 without exposing body contents', async () => {
  for (const body of [
    new Response('<html>private upstream contents</html>',{status:403,headers:{'Content-Type':'text/html'}}),
    new Response('{broken', {status:403,headers:{'Content-Type':'application/json'}}),
    Response.json({error:{message:'private upstream contents'+'x'.repeat(17000)}},{status:403}),
  ]) {
    const res = await withFetch(async () => body, () => worker.fetch(request(),env));
    assert.equal(res.status,403);
    const text = await res.text();
    assert.ok(text.includes('仅凭 403'));
    assert.ok(!text.includes('private upstream contents'));
  }
});
