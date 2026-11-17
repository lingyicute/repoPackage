/**
 * MusicDatabase 收集器 Cloudflare Worker by lingyicute
 *
 * 功能：接收前端上报（歌名/歌手/专辑图url/歌曲文件url/歌词url），
 * 先检查 main 分支 list.txt（已收集目录）：
 *   - 已收集过 → 直接返回 skipped，不创建 JSON、不推送（避免无效循环）；
 *   - 未收集过 → 在 GitHub 仓库的 goodurl 分支新建（或更新）一个 JSON 文件，
 * 文件名格式：【歌名-歌手】.json，然后 commit 回 goodurl 分支。
 *
 * 需要的 Secret / Vars
 *   GITHUB_TOKEN  (secret)  fine-grained token，只需 MusicDatabase 仓库的 Contents: Read and write
 *   GITHUB_REPO   (var)     例如 "lingyicute/MusicDatabase"
 *   GITHUB_BRANCH (var)     例如 "goodurl"
 *   JSON_DIR      (var,可选) JSON 存放目录，默认根目录 ""
 *   ALLOWED_ORIGIN(var,可选) CORS 允许的来源，默认 "*"
 */

const GH_API = "https://api.github.com";

/* ---------- 工具 ---------- */

// 文件名清洗：GitHub/各系统非法字符与控制字符替换为 _，并限制长度
function sanitizeName(s, maxLen = 80) {
  let out = String(s || "")
    .replace(/[\/\\?%*:|"<>]/g, "_")   // 文件系统 + URL 非法字符
    .replace(/[\x00-\x1f\x7f]/g, "")    // 控制字符
    .replace(/\.+$/g, "")               // 结尾的点（Windows 不允许）
    .trim()
    .replace(/\s+/g, " ");
  if (out.length > maxLen) out = out.slice(0, maxLen).trim();
  // 全是点/空/保留名时兜底
  if (!out || /^[._\s]+$/.test(out) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = "unknown";
  return out;
}

// Worker 内 UTF-8 → base64（GitHub contents API 要求 content 为 base64）
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function isHttpUrl(u) {
  return typeof u === "string" && /^https?:\/\/.+/i.test(u.trim());
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResp(obj, status, env, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env), ...extra },
  });
}

/* ---------- GitHub API ---------- */

function ghHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "MusicDatabase-collector-worker",
  };
}

// 确保 goodurl 分支存在；不存在则从默认分支（main）创建
async function ensureBranch(env) {
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "goodurl";
  const branchUrl = `${GH_API}/repos/${repo}/branches/${encodeURIComponent(branch)}`;
  let r = await fetch(branchUrl, { headers: ghHeaders(env) });
  if (r.status === 200) return; // 已存在
  if (r.status !== 404) throw new Error(`检查分支失败: HTTP ${r.status}`);
  // 分支不存在 → 取默认分支 SHA 并创建
  const repoInfo = await (await fetch(`${GH_API}/repos/${repo}`, { headers: ghHeaders(env) })).json();
  const defaultBranch = repoInfo.default_branch || "main";
  const ref = await (await fetch(
    `${GH_API}/repos/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
    { headers: ghHeaders(env) }
  )).json();
  const sha = ref?.object?.sha;
  if (!sha) throw new Error("无法获取默认分支 SHA，创建分支失败");
  const create = await fetch(`${GH_API}/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  if (!(create.status === 201 || create.status === 200)) {
    const t = await create.text();
    throw new Error(`创建分支 ${branch} 失败: HTTP ${create.status} ${t.slice(0, 200)}`);
  }
}

// 查询文件现有 sha（不存在返回 null）
async function getFileSha(env, path) {
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "goodurl";
  const url = `${GH_API}/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, { headers: ghHeaders(env) });
  if (r.status === 200) {
    const j = await r.json();
    return j.sha || null;
  }
  if (r.status === 404) return null;
  throw new Error(`查询文件失败: HTTP ${r.status}`);
}

// 读取 main 分支 list.txt（已收集目录，每行一个【歌名-歌手】），返回 Set
// 返回 { set, unavailable }：文件不存在(404)视为空集；其他错误则 unavailable=true（调用方决定 fail-open）
async function fetchCollectedSet(env) {
  const repo = env.GITHUB_REPO;
  const url = `${GH_API}/repos/${repo}/contents/list.txt?ref=main`;
  const r = await fetch(url, {
    headers: { ...ghHeaders(env), "Accept": "application/vnd.github.raw" },
  });
  if (r.status === 404) return { set: new Set(), unavailable: false }; // 还没生成过目录
  if (r.status !== 200) return { set: new Set(), unavailable: true };
  const set = new Set();
  for (const line of (await r.text()).split("\n")) {
    const t = line.trim();
    if (t) set.add(t);
  }
  return { set, unavailable: false };
}

// 新建或更新文件（带一次 sha 冲突重试）
async function putFile(env, path, contentB64, message) {
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "goodurl";
  const url = `${GH_API}/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sha = await getFileSha(env, path);
    const body = { message, content: contentB64, branch };
    if (sha) body.sha = sha;
    const r = await fetch(url, {
      method: "PUT",
      headers: { ...ghHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 200 || r.status === 201) return await r.json();
    if (r.status === 409 || r.status === 422) continue; // 并发冲突，重查 sha 再试一次
    const t = await r.text();
    throw new Error(`写入文件失败: HTTP ${r.status} ${t.slice(0, 300)}`);
  }
  throw new Error("写入文件冲突，重试后仍失败");
}

/* ---------- 主逻辑 ---------- */

async function handleReport(request, env) {
  if (!env.GITHUB_TOKEN) return jsonResp({ ok: false, error: "worker 未配置 GITHUB_TOKEN" }, 500, env);
  if (!env.GITHUB_REPO) return jsonResp({ ok: false, error: "worker 未配置 GITHUB_REPO" }, 500, env);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ ok: false, error: "body 不是合法 JSON" }, 400, env);
  }

  const title = String(body.title || "").trim();
  const author = String(body.author || "").trim();
  const pic = String(body.pic || "").trim();
  const fileUrl = String(body.url || "").trim();
  const lrc = String(body.lrc || "").trim();

  // 校验：歌名/歌手必填，歌曲文件 url 必须是 http(s)
  if (!title || !author) return jsonResp({ ok: false, error: "缺少 title 或 author" }, 400, env);
  if (!isHttpUrl(fileUrl)) return jsonResp({ ok: false, error: "缺少合法的歌曲文件 url" }, 400, env);
  if (pic && !isHttpUrl(pic)) return jsonResp({ ok: false, error: "专辑图 url 非法" }, 400, env);
  if (lrc && !isHttpUrl(lrc)) return jsonResp({ ok: false, error: "歌词 url 非法" }, 400, env);
  if (title.length > 200 || author.length > 200) return jsonResp({ ok: false, error: "歌名/歌手过长" }, 400, env);
  if (fileUrl.length > 2000 || pic.length > 2000 || lrc.length > 2000) {
    return jsonResp({ ok: false, error: "url 过长" }, 400, env);
  }

  // 文件名：【歌名-歌手】.json（同名重复上报则更新覆盖，保证 url 是最新未过期的）
  const stem = `${sanitizeName(title)}-${sanitizeName(author)}`;
  const fileName = `${stem}.json`;
  const dir = String(env.JSON_DIR || "").trim().replace(/^\/+|\/+$/g, "");
  const path = dir ? `${dir}/${fileName}` : fileName;

  const record = {
    title,
    author,
    pic,
    url: fileUrl,
    lrc,
    songmid: String(body.songmid || ""),
    duration: Number(body.duration) || null,
    reportedAt: new Date().toISOString(),
  };

  try {
    // 去重挡板：已收集过的直接跳过，不创建 JSON、不推送
    const { set: collected, unavailable } = await fetchCollectedSet(env);
    if (!unavailable && collected.has(stem)) {
      return jsonResp({ ok: true, skipped: true, file: fileName, reason: "already collected" }, 200, env);
    }
    await ensureBranch(env);
    await putFile(env, path, b64encodeUtf8(JSON.stringify(record, null, 2) + "\n"), `collector: ${title} - ${author}`);
    // unavailable 时为 fail-open：list.txt 读失败也照常创建（至多产生一个重复 JSON，次日 cleanup 会删）
    return jsonResp({ ok: true, skipped: false, path, file: fileName, listCheck: unavailable ? "unavailable" : "miss" }, 200, env);
  } catch (e) {
    return jsonResp({ ok: false, error: String(e?.message || e) }, 502, env);
  }
}

/* ---------- 入口 ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === "/report" && request.method === "POST") {
      return handleReport(request, env);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResp({ ok: true, repo: env.GITHUB_REPO || null, branch: env.GITHUB_BRANCH || "goodurl" }, 200, env);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return jsonResp(
        { name: "MusicDatabase collector", usage: "POST /report {title,author,pic,url,lrc}", health: "GET /health" },
        200,
        env
      );
    }

    return jsonResp({ ok: false, error: "not found" }, 404, env);
  },
};
