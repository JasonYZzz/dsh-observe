import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const results = resolve('.test-results');
await mkdir(results, { recursive: true });
const home = await mkdtemp(join(tmpdir(), 'dsh-observe-web-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|TOKEN|SECRET|PASSWORD|^DSH_HOME$/i.test(key)));
env.DSH_HOME = home; env.DSH_OBSERVE_LARGE_TEST = '1';
const fixturePatch = join(results, 'fixture.patch.yml');
await writeFile(fixturePatch, `- insert:\n    - id: observe-test-fixtures\n      name: ${JSON.stringify(resolve('tests/fixtures/host/index.mjs'))}\n`);
const sanitize = (value) => value.replace(/([?&]token=)[^\s&)]+/g, '$1[REDACTED]');
let browser; let page; let host; let output = ''; const errors = [];
const phaseResults = [];
async function command(binary, args) {
  try { return await exec(binary, args, { env, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { throw new Error(`${binary} failed: ${sanitize(String(error.stderr ?? error.message))}`); }
}
async function stopHost(signal = 'SIGTERM') {
  if (!host || host.exitCode !== null) return;
  const child = host;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill(signal);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited; clearTimeout(timer); host = undefined;
}
async function startHost(fixtures = true) {
  output = '';
  await rm(join(home, 'fixture-ready'), { force: true });
  host = spawn('dsh', ['--profile', 'web', ...(fixtures ? ['--patch', fixturePatch] : []), '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [host.stdout, host.stderr]) stream.on('data', (chunk) => { output += chunk.toString(); });
  for (let i = 0; i < 300; i++) {
    const url = output.match(/dsh web: (http:\/\/\S+)/)?.[1];
    if (url && (!fixtures || await stat(join(home, 'fixture-ready')).then(() => true, () => false))) return url;
    if (host.exitCode !== null) throw new Error('Host exited before startup');
    await delay(100);
  }
  throw new Error('Host startup timed out');
}
async function dismissOnboarding() {
  for (const name of ['继续', '稍后配置']) await page.getByRole('button', { name, exact: true }).click({ timeout: 1500 }).catch((error) => { if (error.name !== 'TimeoutError') throw error; });
}
async function rpc(context, base, endpoint, payload = {}) {
  const response = await context.request.post(`${base}/api/dsh-observe/${endpoint}`, { data: { type: 'client-request', rpcId: randomUUID(), method: `dsh-observe/${endpoint}`, payload } });
  assert.equal(response.status(), 200);
  const result = (await response.json()).result;
  assert.equal(result.ok, true, `${endpoint}: ${result.error?.message}`);
  return result.value;
}
async function sourceHashes() {
  const directory = join(home, 'sessions');
  const files = (await readdir(directory, { recursive: true })).filter((path) => /\.(json|jsonl|zstd)$/.test(path));
  return Promise.all(files.sort().map(async (path) => [path, createHash('sha256').update(await readFile(join(directory, path))).digest('hex')]));
}
try {
  const version = JSON.parse(await readFile('package.json','utf8')).version;
  await command('npm',['pack','--ignore-scripts','--pack-destination',results]);
  const tarball=join(results,`dsh-observe-${version}.tgz`);const digest=createHash('sha256').update(await readFile(tarball)).digest('hex');
  const uniqueTarball=join(results,`dsh-observe-${version}-${digest.slice(0,12)}.tgz`);await writeFile(uniqueTarball,await readFile(tarball));
  await command('dsh',['plugin','--profile','web','add',uniqueTarball]);
  browser=await chromium.launch({headless:true,executablePath:process.env.DSH_TEST_CHROME});
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1600,height:1050}});
  page=await context.newPage();page.on('pageerror',(error)=>errors.push(error.message));
  const url=await startHost();const base=new URL(url).origin;
  await page.goto(url);await dismissOnboarding();await page.getByRole('button',{name:'观测',exact:true}).click();
  await page.getByRole('heading',{name:'最近执行',exact:true}).waitFor();
  const firstHealth=await rpc(context,base,'health.get');assert.equal(firstHealth.pluginVersion,version);assert.equal(firstHealth.capture.failedSessions,0);
  await page.getByRole('button',{name:'输入会话 ID',exact:true}).count();
  await page.goto(`${base}/?observeSession=observe-fixture-v2-request`);await dismissOnboarding();
  const requestRuns=await rpc(context,base,'runs.list',{sessionId:'observe-fixture-v2-request'});const runId=requestRuns.items[0].id;
  await page.getByLabel('选择执行轮次',{exact:true}).selectOption(runId);
  await page.locator('.observe-node-button[data-kind="attempt"]').first().click();
  await page.locator('.observe-content pre').filter({hasText:'Please read example.txt.'}).first().waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('fixture-secret-never-expose'));
  assert.match(await page.getByLabel('选择执行轮次',{exact:true}).locator('option:checked').innerText(),/^第1轮/);
  assert.equal(await page.locator('.observe-node-button[data-kind="step"] strong').first().innerText(),'第1步');
  assert.match(await page.locator('.observe-run-facts').innerText(),/第1轮/);
  await page.getByRole('tab',{name:/请求上下文/}).click();
  await page.locator('.observe-content-item').first().locator('summary').click();
  await page.locator('.observe-content pre').filter({hasText:'You are a synthetic assistant for request inspection.'}).first().waitFor();
  await page.getByRole('tab',{name:/工具定义/}).click();
  await page.locator('.observe-content-item').first().locator('summary').click();
  await page.locator('.observe-content pre').filter({hasText:'parameters'}).waitFor();
  await page.locator('.observe-node-button[data-kind="tool"]').first().click();
  await page.locator('.observe-content pre').filter({hasText:'example.txt'}).first().waitFor();
  await page.locator('.observe-content').nth(1).getByRole('button',{name:'下一页',exact:true}).click();
  await page.locator('.observe-content pre').filter({hasText:'LAST PAGE VERIFIED'}).first().waitFor();
  const deepLink=page.url();assert.equal(new URL(deepLink).searchParams.has('token'),false);
  await page.screenshot({path:join(results,'run-desktop.png')});
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:join(results,'run-dark.png')});
  await page.setViewportSize({width:390,height:844});await page.getByRole('tab',{name:'详情',exact:true}).click();
  await page.screenshot({path:join(results,'run-mobile.png')});
  await page.setViewportSize({width:1600,height:1050});await page.goto(deepLink);await dismissOnboarding();
  await page.getByRole('heading',{name:'read_file',exact:true}).waitFor();
  await page.getByRole('tab',{name:'源事件',exact:true}).click();
  await page.locator('.observe-content pre').filter({hasText:'tool/call'}).first().waitFor();
  const sourceBefore=await sourceHashes();
  await rpc(context,base,'requests.get',{runId});
  assert.deepEqual(await sourceHashes(),sourceBefore);
  phaseResults.push('native request input/output; historical system context; effective tool schema; tool arguments/results; content pagination; credential redaction; light/dark/mobile; refreshable node link; source files unchanged');
  const nativePreparation=JSON.parse(await readFile(join(home,'native-preparation.json'),'utf8'));
  await page.goto(`${base}/?observeSession=observe-fixture-v2-classified`);await dismissOnboarding();
  const classifiedRuns=await rpc(context,base,'runs.list',{sessionId:'observe-fixture-v2-classified'});
  await page.getByLabel('选择执行轮次',{exact:true}).selectOption(classifiedRuns.items[0].id);
  await page.locator('.observe-node-button[data-kind="attempt"]').first().click();
  await page.getByRole('heading',{name:'本次上下文注入 · 3',exact:true}).waitFor();
  const approval=page.locator('.observe-content-item[data-category="context"]').first();
  assert.match(await approval.locator('summary').innerText(),/上下文.*审批设置/s);
  assert.equal(await page.locator('.observe-content-item[data-category="user"]').count(),1);
  assert.equal(await page.locator('.observe-content-item[data-category="assistant"]').count(),1);
  await approval.locator('summary').click();await approval.locator('pre').waitFor();
  await approval.getByText('消息来源',{exact:true}).click();assert.match(await approval.innerText(),/user-approval/);
  await approval.getByText('消息来源',{exact:true}).click();
  await page.emulateMedia({colorScheme:'light'});await page.screenshot({path:join(results,'roles-desktop.png')});
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:join(results,'roles-dark.png')});
  await page.setViewportSize({width:390,height:844});await page.getByRole('tab',{name:'详情',exact:true}).click();
  await page.screenshot({path:join(results,'roles-mobile.png')});
  assert.ok(await page.locator('.observe-inspector').evaluate(el=>el.scrollWidth<=el.clientWidth));
  await page.setViewportSize({width:1600,height:1050});
  await page.getByRole('tab',{name:/请求上下文/}).click();
  await page.locator('.observe-role-filters button').filter({hasText:/^上下文/}).click();
  await page.locator('.observe-content-item[data-category="system"]').waitFor({state:'detached'});
  assert.equal(await page.locator('.observe-content-item').count(),3);
  await page.locator('.observe-role-filters button').filter({hasText:/^用户/}).click();
  await page.locator('.observe-content-item[data-category="context"]').first().waitFor({state:'detached'});
  assert.equal(await page.locator('.observe-content-item').count(),1);
  assert.match(await page.locator('.observe-role').innerText(),/^用户$/);
  phaseResults.push('Chinese message badges; source-aware user/context separation; protocol source disclosure; semantic filters and counts; desktop/dark/390px labels');
  await page.getByRole('button',{name:'运维日志',exact:true}).click();
  const logView=page.locator('.observe-logs');
  await logView.getByText('当前范围未采集到运维日志。',{exact:true}).waitFor();
  assert.match(await logView.innerText(),/不搜索聊天、请求上下文或工具正文/);
  await logView.getByRole('button',{name:'查看未关联日志',exact:true}).waitFor();
  await page.emulateMedia({colorScheme:'light'});await page.screenshot({path:join(results,'logs-empty-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(results,'logs-empty-mobile.png')});
  await page.setViewportSize({width:1600,height:1050});
  await logView.getByLabel('摘要关键词',{exact:true}).fill('old filter cleared by shortcut');
  await logView.getByRole('button',{name:'搜索日志',exact:true}).click();
  await logView.getByRole('button',{name:'查看未关联日志',exact:true}).click();
  await logView.locator('td pre').filter({hasText:'sanitized test diagnostic'}).first().waitFor();
  assert.equal(await logView.getByLabel('摘要关键词',{exact:true}).inputValue(),'');
  await logView.getByLabel('摘要关键词',{exact:true}).fill('SANITIZED TEST DIAGNOSTIC');
  await logView.getByRole('button',{name:'搜索日志',exact:true}).click();
  await logView.locator('td pre').filter({hasText:'sanitized test diagnostic'}).first().waitFor();
  await logView.getByLabel('来源',{exact:true}).fill('observe-fixt');
  await logView.getByRole('button',{name:'搜索日志',exact:true}).click();
  await logView.getByText('没有日志符合当前筛选条件，可清空筛选后重试。',{exact:true}).waitFor();
  await logView.getByLabel('来源',{exact:true}).fill('observe-fixture');
  await logView.getByRole('button',{name:'搜索日志',exact:true}).click();
  await logView.locator('td pre').filter({hasText:'sanitized test diagnostic'}).first().waitFor();
  await logView.getByRole('button',{name:'清空',exact:true}).click();
  await logView.getByLabel('关联范围',{exact:true}).selectOption('all');
  await logView.locator('td pre').filter({hasText:'ScopeProbe'}).first().waitFor();
  await page.goto(`${base}/?observeSession=observe-fixture-v2-request`);await dismissOnboarding();
  await page.getByRole('button',{name:'运维日志',exact:true}).click();
  await logView.locator('td pre').filter({hasText:'搜索命中'}).first().waitFor();
  await logView.getByLabel('摘要关键词',{exact:true}).fill('  搜索命中  ');
  await logView.getByRole('button',{name:'搜索日志',exact:true}).click();
  await logView.locator('td pre').filter({hasText:'搜索命中'}).first().waitFor();
  await page.screenshot({path:join(results,'logs-results-desktop.png')});
  const logProbe=await rpc(context,base,'logs.list',{sessionId:'observe-fixture-v2-request',text:'ScopeProbe'});
  assert.equal(logProbe.items.length,1);assert.equal(logProbe.scopeCount,1);assert.ok(logProbe.unassociatedCount>0);
  phaseResults.push('Chinese turn/step labels; captured-vs-unmatched empty states; session/all/unassociated scopes; keyword substring/ASCII case; exact source; clear filters; desktop/mobile log guidance');
  const started=performance.now();const large=await rpc(context,base,'runs.list',{sessionId:'observe-fixture-v2-large'});const indexedLargeMs=performance.now()-started;
  await page.goto(`${base}/?observeSession=observe-fixture-v2-large&observeRun=${encodeURIComponent(large.items[0].id)}`);await dismissOnboarding();
  const calls=page.locator('.observe-node-button');await calls.first().waitFor();assert.equal(await calls.count(),50);
  const firstPage=await calls.allInnerTexts();await page.getByRole('navigation',{name:'调用树',exact:true}).getByRole('button',{name:'下一页',exact:true}).click();
  await page.waitForFunction((first)=>document.querySelector('.observe-node-button')?.innerText!==first,firstPage[0]);
  assert.equal(await calls.count(),50);assert.ok(!(await calls.allInnerTexts()).some((text)=>firstPage.includes(text)));
  await calls.first().focus();await page.keyboard.press('Enter');
  let requests=0;const count=(request)=>{if(request.url().includes('/api/dsh-observe/'))requests++;};page.on('request',count);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  const beforeHidden=requests;await delay(5200);assert.equal(requests,beforeHidden);
  const resumed=page.waitForRequest((request)=>request.url().includes('/api/dsh-observe/'));await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await resumed;page.off('request',count);
  phaseResults.push('10002-node history; 50 rows per page; pagination uniqueness; keyboard selection; hidden polling suspension');
  assert.equal((await fetch(`${base}/api/dsh-observe/requests.get`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  for(const endpoint of ['requests.get','content.get']) for(const headers of [{Origin:'https://untrusted.invalid'},{Host:'untrusted.invalid'}]) assert.equal((await context.request.post(`${base}/api/dsh-observe/${endpoint}`,{headers,data:{}})).status(),403);
  assert.equal((await context.request.post(`${base}/api/dsh-observe/context.bind`,{data:{}})).status(),404);
  phaseResults.push('new content APIs preserve native authentication and Host/Origin fences; no browser identity mutation');
  await stopHost('SIGKILL');const restartedUrl=await startHost();const restartedBase=new URL(restartedUrl).origin;await page.goto(restartedUrl);
  const restored=await rpc(context,restartedBase,'runs.get',{runId});assert.equal(restored.id,runId);
  for(const name of ['success','failure','retry','cancel','subagent','compaction','nested','fork','recovery','summary','prune','request','classified']) await rpc(context,restartedBase,'runs.list',{sessionId:`observe-fixture-v2-${name}`});
  assert.ok(!output.includes('did not activate'));phaseResults.push('SIGKILL/restart; stable IDs; thirteen native cold fixtures');
  await stopHost();await command('dsh',['plugin','--profile','web','remove','dsh-observe']);assert.ok((await stat(join(home,'storages/dsh-observe/observe.sqlite'))).size>0);
  const uninstalled=await startHost(false);await page.goto(uninstalled);assert.equal((await context.request.post(`${new URL(uninstalled).origin}/api/dsh-observe/health.get`,{data:{}})).status(),404);
  assert.equal(await page.getByRole('button',{name:'观测',exact:true}).count(),0);phaseResults.push('uninstall preserves database; native Web available');
  assert.deepEqual(errors,[]);
  await writeFile('docs/verification/web-smoke.json',JSON.stringify({measuredAt:new Date().toISOString(),version,tarballSha256:digest,nativePreparation,indexedLargeMs,phases:phaseResults,modelCalls:0,fixtureSource:'synthetic native events; no Agent created by fixture plugin'},null,2)+'\n');
  console.log(`PASS: ${phaseResults.join('; ')}`);
} catch(error) {
  if(page){await page.screenshot({path:join(results,'web-failure.png')}).catch(()=>{});await writeFile(join(results,'browser-text.txt'),await page.locator('body').innerText().catch(()=>''));}
  await writeFile(join(results,'host-sanitized.log'),sanitize(output));await writeFile(join(results,'completed-phases.json'),JSON.stringify(phaseResults));
  throw new Error(sanitize(String(error.message)).replace(/cookie:[^\n]+/gi,'cookie: [REDACTED]'));
} finally {await browser?.close();await stopHost();await rm(home,{recursive:true,force:true});}
