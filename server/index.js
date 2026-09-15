const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const url = require('url');

const PORT = process.env.GIT_WEB_PORT || 3456;
const STATIC_DIR = path.join(__dirname, '..');
const HISTORY_FILE = path.join(__dirname, 'path-history.json');
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const tokens = new Map();

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveTokens(obj) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2));
}
function loadAllTokens() {
  const obj = loadTokens();
  Object.keys(obj).forEach(function(k) { tokens.set(k, obj[k]); });
}
function persistTokens() {
  const obj = {};
  tokens.forEach(function(v, k) { obj[k] = v; });
  saveTokens(obj);
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) { return []; }
}
function saveHistory(list) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const respond = (s, d) => {
    if (res.writableEnded) return;
    res.writeHead(s, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    res.end(JSON.stringify(d));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    return res.end();
  }

  if (req.url.startsWith('/api/')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch(e) {}

    const tok = (req.headers.authorization || '').replace('Bearer ', '');

    if (req.url === '/api/auth/login' && req.method === 'POST') {
      if (data.username === 'admin' && data.password === 'admin@123') {
        const t = 'tok_' + Math.random().toString(36).slice(2);
        tokens.set(t, true);
        persistTokens();
        return respond(200, { success: true, token: t, message: 'OK' });
      }
      return respond(401, { success: false, message: 'auth failed' });
    }

    if (!tokens.has(tok)) return respond(401, { success: false, message: 'no auth' });

    const dir = data.path ? path.resolve(data.path) : null;

    const ensureGit = () => {
      if (!dir) throw new Error('path required');
      fs.statSync(dir);
      fs.statSync(path.join(dir, '.git'));
      return dir;
    };

    const friendlyGitError = (raw) => {
      const s = String(raw || '');
      if (/could not resolve host|unable to access|connection timed out|failed to connect|network is unreachable|operation timed out|recv failure|connection reset/i.test(s))
        return '无法连接远程仓库（网络不通或被墙），请检查服务器网络或配置 git 代理';
      if (/authentication failed|could not read username|invalid username or password|permission denied|403|401/i.test(s))
        return '认证失败：请检查远程仓库的凭证/Token 是否有效';
      if (/fetch first|non-fast-forward|updates were rejected/i.test(s))
        return '推送被拒绝：远程有新提交，请先 Pull 再 Push';
      if (/diverged|need to specify how to reconcile/i.test(s))
        return '分支已分叉：请先 Pull 合并后再 Push';
      if (/author identity unknown|please tell me who you are/i.test(s))
        return '未配置 git 提交身份，请设置 user.name / user.email';
      if (/no such remote|does not appear to be a git repository/i.test(s))
        return '远程仓库不存在或未配置';
      if (/pathspec|did not match any file/i.test(s))
        return '文件路径不存在或未匹配';
      const firstLine = s.split('\n').filter(Boolean)[0] || '未知错误';
      return firstLine.replace(/^(fatal|error):\s*/i, '').trim() || '操作失败';
    };

    const gitCmd = (args, cwd, timeout) => new Promise((resolve, reject) => {
      const limit = timeout || 30000;
      const useDir = cwd || dir;
      const cfgArgs = ['-c', 'core.quotepath=false'];
      if (useDir) cfgArgs.push('-c', 'safe.directory=' + useDir);
      const fullArgs = cfgArgs.concat(args);
      const c = spawn('git', fullArgs, { cwd: useDir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_EDITOR: 'true', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' } });
      let out = '', err = '', done = false;
      const timer = setTimeout(function() {
        done = true;
        try { c.kill('SIGKILL'); } catch(e) {}
        reject(new Error('操作超时（超过 ' + Math.round(limit / 1000) + 's）：无法连接远程仓库，请检查网络或配置 git 代理'));
      }, limit);
      c.stdout.on('data', d => { out += d; });
      c.stderr.on('data', d => { err += d; });
      c.on('close', code => {
        if (done) return;
        clearTimeout(timer);
        code === 0 ? resolve(out.trim()) : reject(new Error(friendlyGitError(err.trim() || out.trim())));
      });
      c.on('error', e => { if (done) return; clearTimeout(timer); reject(e); });
    });

    const gitSafe = (args, cwd, timeout) => gitCmd(args, cwd, timeout).catch(function() { return ''; });

    try {
      if (req.url === '/api/history' && req.method === 'GET') {
        const list = loadHistory();
        return respond(200, { success: true, list });
      }

      if (req.url === '/api/history' && req.method === 'POST') {
        const p = data.path;
        if (!p) return respond(400, { success: false, message: 'path required' });
        let list = loadHistory();
        list = list.filter(function(x) { return x !== p; });
        list.unshift(p);
        if (list.length > 20) list = list.slice(0, 20);
        saveHistory(list);
        return respond(200, { success: true, list });
      }

      if (req.url === '/api/history' && req.method === 'DELETE') {
        const p = data.path;
        let list = loadHistory();
        if (p) list = list.filter(function(x) { return x !== p; });
        else list = [];
        saveHistory(list);
        return respond(200, { success: true, list });
      }

      if (req.url === '/api/git/validate') {
        ensureGit();
        const branch = await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD']);
        const log = await gitSafe(['log', '--oneline', '-5']);
        return respond(200, { success: true, path: dir, branch, recentLog: log, message: 'OK' });
      }

      if (req.url === '/api/git/status') {
        ensureGit();
        const branch = await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD']);
        const status = await gitCmd(['status']);
        const diffStat = await gitSafe(['diff', '--stat']);
        const diffCached = await gitSafe(['diff', '--cached', '--stat']);
        const untracked = await gitSafe(['ls-files', '--others', '--exclude-standard']);
        const log = await gitSafe(['log', '--oneline', '-5']);
        const stashList = await gitSafe(['stash', 'list']);
        const modifiedFiles = await gitSafe(['diff', '--name-only']);
        const stagedFiles = await gitSafe(['diff', '--cached', '--name-only']);
        const untrackedFiles = await gitSafe(['ls-files', '--others', '--exclude-standard']);

        let output = '=== Branch: ' + branch + ' ===\n\n';
        output += '--- Status ---\n' + (status || '(clean)') + '\n\n';
        if (diffStat) output += '--- Unstaged Changes ---\n' + diffStat + '\n\n';
        if (diffCached) output += '--- Staged Changes ---\n' + diffCached + '\n\n';
        if (untracked) output += '--- Untracked Files ---\n' + untracked + '\n\n';
        if (stashList) output += '--- Stash List ---\n' + stashList + '\n\n';
        if (log) output += '--- Recent Commits ---\n' + log;

        return respond(200, {
          success: true, output, branch,
          files: {
            modified: modifiedFiles ? modifiedFiles.split('\n').filter(Boolean) : [],
            staged: stagedFiles ? stagedFiles.split('\n').filter(Boolean) : [],
            untracked: untrackedFiles ? untrackedFiles.split('\n').filter(Boolean) : []
          }
        });
      }

      if (req.url === '/api/git/add') {
        ensureGit();
        const files = data.files;
        if (files && Array.isArray(files) && files.length > 0) {
          await gitCmd(['add', ...files]);
        } else {
          await gitCmd(['add', '.']);
        }
        const status = await gitCmd(['status', '--short']);
        const diffCached = await gitSafe(['diff', '--cached', '--stat']);
        let output = 'OK\n\n';
        if (diffCached) output += '--- Staged Content ---\n' + diffCached + '\n\n';
        if (status) output += '--- Current Status ---\n' + status;
        else output += '(all changes staged)';
        return respond(200, { success: true, message: 'files staged', output });
      }

      if (req.url === '/api/git/reset') {
        ensureGit();
        const files = data.files;
        if (files && Array.isArray(files) && files.length > 0) {
          await gitCmd(['reset', 'HEAD', '--', ...files]);
        } else {
          await gitCmd(['reset', 'HEAD']);
        }
        const status = await gitCmd(['status', '--short']);
        const diffCached = await gitSafe(['diff', '--cached', '--stat']);
        let output = 'OK\n\n';
        if (diffCached) output += '--- Staged Content ---\n' + diffCached + '\n\n';
        if (status) output += '--- Current Status ---\n' + status;
        else output += '(clean)';
        return respond(200, { success: true, message: 'files unstaged', output });
      }

      if (req.url === '/api/git/pull') {
        ensureGit();
        const branch = await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD']);
        const out = await gitCmd(['pull'], dir, 45000);
        const log = await gitSafe(['log', '--oneline', '-5']);
        let output = '--- Pull Result ---\n' + (out || '(up to date)') + '\n\n';
        if (log) output += '--- Recent Commits ---\n' + log;
        return respond(200, { success: true, message: 'pull done', output, branch });
      }

      if (req.url === '/api/git/push') {
        ensureGit();
        const branch = await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD']);
        const st = await gitCmd(['status', '--porcelain']);
        const commitMsg = data.message || 'Web Auto Commit';

        let output = '';
        if (st) {
          await gitCmd(['add', '.']);
          const commitResult = await gitCmd(['commit', '-m', commitMsg]);
          output += '--- Commit ---\n' + commitResult + '\n\n';
        } else {
          output += '--- No changes ---\n\n';
        }

        let pushMsg = '', pushOk = true, pushErr = '';
        try {
          pushMsg = await gitCmd(['push'], dir, 45000);
        } catch(e) { pushOk = false; pushErr = e.message; }
        output += '--- Push Result ---\n' + (pushOk ? (pushMsg || '(done)') : pushErr) + '\n\n';

        const log = await gitSafe(['log', '--oneline', '-5']);
        if (log) output += '--- Recent Commits ---\n' + log;

        if (!pushOk) {
          return respond(200, { success: false, message: 'push 失败: ' + (pushErr.split('\n')[0] || '请先 pull'), output, branch, pushed: false });
        }
        return respond(200, { success: true, message: st ? 'committed and pushed' : 'no changes', output, branch, pushed: true });
      }

      if (req.url === '/api/git/stash') {
        ensureGit();
        const action = data.action || 'list';
        const message = data.message || '';

        if (action === 'list') {
          const list = await gitSafe(['stash', 'list']);
          return respond(200, { success: true, output: list || '(no stash)', stashList: list });
        }

        if (action === 'save') {
          const out = await gitCmd(['stash', 'push', '-m', message || 'Web Stash']);
          const list = await gitSafe(['stash', 'list']);
          let output = '--- Stash Saved ---\n' + (out || '(saved)') + '\n\n';
          if (list) output += '--- Current Stash List ---\n' + list;
          return respond(200, { success: true, message: 'stash saved', output });
        }

        if (action === 'pop') {
          const out = await gitCmd(['stash', 'pop']);
          const status = await gitSafe(['status', '--short']);
          let output = '--- Stash Pop ---\n' + (out || '(restored)') + '\n\n';
          if (status) output += '--- Current Status ---\n' + status;
          return respond(200, { success: true, message: 'stash restored', output });
        }

        if (action === 'drop') {
          const index = data.index || '0';
          const out = await gitCmd(['stash', 'drop', 'stash@{' + index + '}']);
          const list = await gitSafe(['stash', 'list']);
          let output = '--- Stash Drop ---\n' + (out || '(deleted)') + '\n\n';
          if (list) output += '--- Current Stash List ---\n' + list;
          else output += '(stash list empty)';
          return respond(200, { success: true, message: 'stash deleted', output });
        }

        if (action === 'clear') {
          await gitCmd(['stash', 'clear']);
          return respond(200, { success: true, message: 'stash cleared', output: 'All stash cleared' });
        }

        respond(400, { success: false, message: 'unknown action: ' + action });
      }

      if (req.url === '/api/git/branch') {
        ensureGit();
        const action = data.action || 'list';
        const branchName = data.name || '';
        const fromBranch = data.from || '';
        const force = !!data.force;

        if (action === 'list') {
          const currentBranch = await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD']);
          const branchOutput = await gitSafe(['branch']);
          const branches = branchOutput
            ? branchOutput.split('\n').filter(Boolean).map(function(line) {
                return { name: line.replace(/^\*?\s+/, ''), current: /^\*/.test(line) };
              })
            : [];
          return respond(200, { success: true, branches, currentBranch: currentBranch.trim(), output: branchOutput });
        }

        if (action === 'create') {
          if (!branchName) return respond(400, { success: false, message: 'branch name required' });
          const base = fromBranch || (await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
          await gitCmd(['branch', branchName, base]);
          return respond(200, { success: true, message: 'branch "' + branchName + '" created from "' + base + '"', output: 'Created branch ' + branchName + ' from ' + base });
        }

        if (action === 'switch') {
          if (!branchName) return respond(400, { success: false, message: 'branch name required' });
          await gitCmd(['checkout', branchName]);
          const newBranch = (await gitCmd(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
          return respond(200, { success: true, message: 'switched to "' + newBranch + '"', branch: newBranch, output: 'Switched to branch ' + newBranch });
        }

        if (action === 'delete') {
          if (!branchName) return respond(400, { success: false, message: 'branch name required' });
          const args = force ? ['branch', '-D', branchName] : ['branch', '-d', branchName];
          const out = await gitCmd(args);
          return respond(200, { success: true, message: 'branch "' + branchName + '" deleted', output: out || ('Deleted branch ' + branchName) });
        }

        respond(400, { success: false, message: 'unknown action: ' + action });
      }

      respond(404, { success: false, message: 'not found' });
    } catch(e) {
      respond(400, { success: false, message: e.message });
    }
    return;
  }

  let reqPath = url.parse(req.url).pathname;
  if (reqPath === '/') reqPath = '/index.html';

  const filePath = path.join(STATIC_DIR, reqPath);
  const safePath = path.resolve(filePath);
  if (!safePath.startsWith(path.resolve(STATIC_DIR))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404 Not Found</h1>');
    }
    const ext = path.extname(safePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(safePath).pipe(res);
  });
});

loadAllTokens();

server.listen(PORT, '0.0.0.0', () => {
  console.log('Mini Git Web started');
  console.log('http://0.0.0.0:' + PORT);
  console.log('admin / admin@123');
});
