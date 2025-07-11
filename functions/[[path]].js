import yaml from 'js-yaml';

const OLD_KV_KEY = 'misub_data_v1';
const KV_KEY_SUBS = 'misub_subscriptions_v1';
const KV_KEY_PROFILES = 'misub_profiles_v1';
const KV_KEY_SETTINGS = 'worker_settings_v1';
const COOKIE_NAME = 'auth_session';
const SESSION_DURATION = 8 * 60 * 60 * 1000;

const defaultSettings = {
  FileName: 'MiSub',
  mytoken: 'auto',
  profileToken: 'profiles',
  subConverter: 'url.v1.mk',
  subConfig: '', // 默認清空，避免問題
  prependSubName: true,
  NotifyThresholdDays: 3, 
  NotifyThresholdPercent: 90 
};

const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes || bytes < 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i < 0) return '0 B';
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

async function sendTgNotification(settings, message) {
  if (!settings.BotToken || !settings.ChatID) {
    console.log("TG BotToken 或 ChatID 未设置, 跳过通知。");
    return false;
  }
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const fullMessage = `${message}\n\n*时间:* \`${now} (UTC+8)\``;
  
  const url = `https://api.telegram.org/bot${settings.BotToken}/sendMessage`;
  const payload = { 
    chat_id: settings.ChatID, 
    text: fullMessage, 
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      console.log("TG 通知已成功发送。");
      return true;
    } else {
      const errorData = await response.json();
      console.error("发送 TG 通知失败：", response.status, errorData);
      return false;
    }
  } catch (error) {
    console.error("发送 TG 通知时出错：", error);
    return false;
  }
}

async function handleCronTrigger(env) {
    console.log("定时任务触发。开始检查所有订阅的流量和节点数量...");
    const allSubs = await env.MISUB_KV.get(KV_KEY_SUBS, 'json') || [];
    const settings = await env.MISUB_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;
    let changesMade = false;
    const nodeRegex = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//gm;

    for (const sub of allSubs) {
        if (sub.url.startsWith('http') && sub.enabled) {
            try {
                const trafficRequest = fetch(new Request(sub.url, { 
                    headers: { 'User-Agent': 'Clash for Windows/0.20.39' }, 
                    redirect: "follow",
                    cf: { insecureSkipVerify: true } 
                }));
                const nodeCountRequest = fetch(new Request(sub.url, { 
                    headers: { 'User-Agent': 'MiSub-Cron-Updater/1.0' }, 
                    redirect: "follow",
                    cf: { insecureSkipVerify: true } 
                }));
                
                const [trafficResult, nodeCountResult] = await Promise.allSettled([
                    Promise.race([trafficRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))]),
                    Promise.race([nodeCountRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))])
                ]);

                if (trafficResult.status === 'fulfilled' && trafficResult.value.ok) {
                    const userInfoHeader = trafficResult.value.headers.get('subscription-userinfo');
                    if (userInfoHeader) {
                        const info = {};
                        userInfoHeader.split(';').forEach(part => {
                            const [key, value] = part.trim().split('=');
                            if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                        });
                        sub.userInfo = info;
                        await checkAndNotify(sub, settings, env);
                        changesMade = true;
                    }
                } else if (trafficResult.status === 'rejected') {
                     console.error(`定时任务：获取 ${sub.name} 的流量失败:`, trafficResult.reason.message);
                }

                if (nodeCountResult.status === 'fulfilled' && nodeCountResult.value.ok) {
                    const text = await nodeCountResult.value.text();
                    let decoded = '';
                    try { 
                        decoded = atob(text.replace(/\s/g, '')); 
                    } catch { 
                        decoded = text; 
                    }
                    const matches = decoded.match(nodeRegex);
                    if (matches) {
                        sub.nodeCount = matches.length;
                        changesMade = true;
                    }
                } else if (nodeCountResult.status === 'rejected') {
                    console.error(`定时任务：获取 ${sub.name} 的节点列表失败:`, nodeCountResult.reason.message);
                }

            } catch(e) {
                console.error(`定时任务：更新 ${sub.name} 时出现未处理的错误`, e.message);
            }
        }
    }

    if (changesMade) {
        await env.MISUB_KV.put(KV_KEY_SUBS, JSON.stringify(allSubs));
        console.log("订阅已更新流量信息和节点数量。");
    } else {
        console.log("定时任务完成，未检测到变化。");
    }
    return new Response("定时任务成功完成。", { status: 200 });
}

async function createSignedToken(key, data) {
    if (!key || !data) throw new Error("签名需要密钥和数据。");
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const dataToSign = encoder.encode(data);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataToSign);
    return `${data}.${Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

async function verifySignedToken(key, token) {
    if (!key || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [data] = parts;
    const expectedToken = await createSignedToken(key, data);
    return token === expectedToken ? data : null;
}

async function authMiddleware(request, env) {
    if (!env.COOKIE_SECRET) return false;
    const cookie = request.headers.get('Cookie');
    const sessionCookie = cookie?.split(';').find(c => c.trim().startsWith(`${COOKIE_NAME}=`));
    if (!sessionCookie) return false;
    const token = sessionCookie.split('=')[1];
    const verifiedData = await verifySignedToken(env.COOKIE_SECRET, token);
    return verifiedData && (Date.now() - parseInt(verifiedData, 10) < SESSION_DURATION);
}

async function checkAndNotify(sub, settings, env) {
    if (!sub.userInfo) return;

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    if (sub.userInfo.expire) {
        const expiryDate = new Date(sub.userInfo.expire * 1000);
        const daysRemaining = Math.ceil((expiryDate - now) / ONE_DAY_MS);
        
        if (daysRemaining <= (settings.NotifyThresholdDays || 7)) {
            if (!sub.lastNotifiedExpire || (now - sub.lastNotifiedExpire > ONE_DAY_MS)) {
                const message = `🗓️ *订阅临期提醒* 🗓️\n\n*订阅名称:* \`${sub.name || '未命名'}\`\n*状态:* \`${daysRemaining < 0 ? '已过期' : `仅剩 ${daysRemaining} 天到期`}\`\n*到期日期:* \`${expiryDate.toLocaleDateString('zh-CN')}\``;
                const sent = await sendTgNotification(settings, message);
                if (sent) {
                    sub.lastNotifiedExpire = now;
                }
            }
        }
    }

    const { upload, download, total } = sub.userInfo;
    if (total > 0) {
        const used = upload + download;
        const usagePercent = Math.round((used / total) * 100);

        if (usagePercent >= (settings.NotifyThresholdPercent || 90)) {
            if (!sub.lastNotifiedTraffic || (now - sub.lastNotifiedTraffic > ONE_DAY_MS)) {
                const message = `📈 *流量预警提醒* 📈\n\n*订阅名称:* \`${sub.name || '未命名'}\`\n*状态:* \`已使用 ${usagePercent}%\`\n*详情:* \`${formatBytes(used)} / ${formatBytes(total)}\``;
                const sent = await sendTgNotification(settings, message);
                if (sent) {
                    sub.lastNotifiedTraffic = now;
                }
            }
        }
    }
}

async function handleApiRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    
    if (path === '/migrate') {
        if (!await authMiddleware(request, env)) { return new Response(JSON.stringify({ error: '未经授权' }), { status: 401 }); }
        try {
            const oldData = await env.MISUB_KV.get(OLD_KV_KEY, 'json');
            const newDataExists = await env.MISUB_KV.get(KV_KEY_SUBS) !== null;

            if (newDataExists) {
                return new Response(JSON.stringify({ success: true, message: '无需迁移，数据已是最新结构。' }), { status: 200 });
            }
            if (!oldData) {
                return new Response(JSON.stringify({ success: false, message: '未找到需要迁移的旧数据。' }), { status: 404 });
            }
            
            await env.MISUB_KV.put(KV_KEY_SUBS, JSON.stringify(oldData));
            await env.MISUB_KV.put(KV_KEY_PROFILES, JSON.stringify([]));
            await env.MISUB_KV.put(OLD_KV_KEY + '_migrated_on_' + new Date().toISOString(), JSON.stringify(oldData));
            await env.MISUB_KV.delete(OLD_KV_KEY);

            return new Response(JSON.stringify({ success: true, message: '数据迁移成功！' }), { status: 200 });
        } catch (e) {
            console.error('[API 错误 /migrate]', e);
            return new Response(JSON.stringify({ success: false, message: `迁移失败: ${e.message}` }), { status: 500 });
        }
    }

    if (path === '/login') {
        if (request.method !== 'POST') return new Response('方法不允许', { status: 405 });
        try {
            const { password } = await request.json();
            if (password === env.ADMIN_PASSWORD) {
                const token = await createSignedToken(env.COOKIE_SECRET, String(Date.now()));
                const headers = new Headers({ 'Content-Type': 'application/json' });
                headers.append('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION / 1000}`);
                return new Response(JSON.stringify({ success: true }), { headers });
            }
            return new Response(JSON.stringify({ error: '密码错误' }), { status: 401 });
        } catch (e) {
            console.error('[API 错误 /login]', e);
            return new Response(JSON.stringify({ error: '请求体解析失败' }), { status: 400 });
        }
    }

    if (!await authMiddleware(request, env)) {
        return new Response(JSON.stringify({ error: '未经授权' }), { status: 401 });
    }

    switch (path) {
        case '/logout': {
            const headers = new Headers({ 'Content-Type': 'application/json' });
            headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
            return new Response(JSON.stringify({ success: true }), { headers });
        }
        
        case '/data': {
            try {
                const [misubs, profiles, settings] = await Promise.all([
                    env.MISUB_KV.get(KV_KEY_SUBS, 'json').then(res => res || []),
                    env.MISUB_KV.get(KV_KEY_PROFILES, 'json').then(res => res || []),
                    env.MISUB_KV.get(KV_KEY_SETTINGS, 'json').then(res => res || {})
                ]);
                const config = { 
                    FileName: settings.FileName || 'MISUB', 
                    mytoken: settings.mytoken || 'auto',
                    profileToken: settings.profileToken || 'profiles'
                };
                return new Response(JSON.stringify({ misubs, profiles, config }), { headers: { 'Content-Type': 'application/json' } });
            } catch(e) {
                console.error('[API 错误 /data]', '从KV读取失败:', e);
                return new Response(JSON.stringify({ error: '读取初始数据失败' }), { status: 500 });
            }
        }

        case '/misubs': {
            try {
                const { misubs, profiles } = await request.json();
                if (typeof misubs === 'undefined' || typeof profiles === 'undefined') {
                    return new Response(JSON.stringify({ success: false, message: '请求体中缺少 misubs 或 profiles 字段' }), { status: 400 });
                }
                
                const settings = await env.MISUB_KV.get(KV_KEY_SETTINGS, 'json') || defaultSettings;
                for (const sub of misubs) {
                    if (sub.url.startsWith('http')) {
                        await checkAndNotify(sub, settings, env);
                    }
                }

                await Promise.all([
                    env.MISUB_KV.put(KV_KEY_SUBS, JSON.stringify(misubs)),
                    env.MISUB_KV.put(KV_KEY_PROFILES, JSON.stringify(profiles))
                ]);
                
                return new Response(JSON.stringify({ success: true, message: '订阅源及订阅组已保存' }));
            } catch (e) {
                console.error('[API 错误 /misubs]', '解析请求或写入KV失败:', e);
                return new Response(JSON.stringify({ error: '保存数据失败' }), { status: 500 });
            }
        }

        case '/node_count': {
            if (request.method !== 'POST') return new Response('方法不允许', { status: 405 });
            const { url: subUrl } = await request.json();
            if (!subUrl || typeof subUrl !== 'string' || !/^https?:\/\//.test(subUrl)) {
                return new Response(JSON.stringify({ error: '无效或缺失的URL' }), { status: 400 });
            }
            
            const result = { count: 0, userInfo: null };

            try {
                const fetchOptions = {
                    headers: { 'User-Agent': 'MiSub-Node-Counter/2.0' },
                    redirect: "follow",
                    cf: { insecureSkipVerify: true }
                };
                const trafficFetchOptions = {
                    headers: { 'User-Agent': 'Clash for Windows/0.20.39' },
                    redirect: "follow",
                    cf: { insecureSkipVerify: true }
                };

                const trafficRequest = fetch(new Request(subUrl, trafficFetchOptions));
                const nodeCountRequest = fetch(new Request(subUrl, fetchOptions));

                const responses = await Promise.allSettled([trafficRequest, nodeCountRequest]);

                if (responses[0].status === 'fulfilled' && responses[0].value.ok) {
                    const trafficResponse = responses[0].value;
                    const userInfoHeader = trafficResponse.headers.get('subscription-userinfo');
                    if (userInfoHeader) {
                        const info = {};
                        userInfoHeader.split(';').forEach(part => {
                            const [key, value] = part.trim().split('=');
                            if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                        });
                        result.userInfo = info;
                    }
                } else if (responses[0].status === 'rejected') {
                    console.error(`获取 ${subUrl} 的流量请求被拒绝:`, responses[0].reason);
                }

                if (responses[1].status === 'fulfilled' && responses[1].value.ok) {
                    const nodeCountResponse = responses[1].value;
                    const text = await nodeCountResponse.text();
                    let decoded = '';
                    try { decoded = atob(text.replace(/\s/g, '')); } catch { decoded = text; }
                    const lineMatches = decoded.match(/^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//gm);
                    if (lineMatches) {
                        result.count = lineMatches.length;
                    }
                } else if (responses[1].status === 'rejected') {
                    console.error(`获取 ${subUrl} 的节点数量请求被拒绝:`, responses[1].reason);
                }
                
                if (result.userInfo || result.count > 0) {
                    const allSubs = await env.MISUB_KV.get(KV_KEY_SUBS, 'json') || [];
                    const subToUpdate = allSubs.find(s => s.url === subUrl);

                    if (subToUpdate) {
                        subToUpdate.nodeCount = result.count;
                        subToUpdate.userInfo = result.userInfo;
                        await env.MISUB_KV.put(KV_KEY_SUBS, JSON.stringify(allSubs));
                    }
                }
                
            } catch (e) {
                console.error(`[API 错误 /node_count] URL: ${subUrl} 出现未处理的异常`, e);
            }
            
            return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
        }

        case '/settings': {
            if (request.method === 'GET') {
                try {
                    const settings = await env.MISUB_KV.get(KV_KEY_SETTINGS, 'json') || {};
                    return new Response(JSON.stringify({ ...defaultSettings, ...settings }), { headers: { 'Content-Type': 'application/json' } });
                } catch (e) {
                    console.error('[API 错误 /settings GET]', '从KV读取设置失败:', e);
                    return new Response(JSON.stringify({ error: '读取设置失败' }), { status: 500 });
                }
            }
            if (request.method === 'POST') {
                try {
                    const newSettings = await request.json();
                    const oldSettings = await env.MISUB_KV.get(KV_KEY_SETTINGS, 'json') || {};
                    const finalSettings = { ...oldSettings, ...newSettings };
                    await env.MISUB_KV.put(KV_KEY_SETTINGS, JSON.stringify(finalSettings));
                    
                    const message = `⚙️ *MiSub 设置更新* ⚙️\n\n您的 MiSub 应用设置已成功更新。`;
                    await sendTgNotification(finalSettings, message);
                    
                    return new Response(JSON.stringify({ success: true, message: '设置已保存' }));
                } catch (e) {
                    console.error('[API 错误 /settings POST]', '解析请求或写入设置到KV失败:', e);
                    return new Response(JSON.stringify({ error: '保存设置失败' }), { status: 500 });
                }
            }
            return new Response('方法不允许', { status: 405 });
        }
    }
    
    return new Response('API 路由未找到', { status: 404 });
}

function prependNodeName(link, prefix) {
  if (!prefix) return link;
  const appendToFragment = (baseLink, namePrefix) => {
    const hashIndex = baseLink.lastIndexOf('#');
    const originalName = hashIndex !== -1 ? decodeURIComponent(baseLink.substring(hashIndex + 1)) : '';
    const base = hashIndex !== -1 ? baseLink.substring(0, hashIndex) : baseLink;
    if (originalName.startsWith(namePrefix)) {
        return baseLink;
    }
    const newName = originalName ? `${namePrefix} - ${originalName}` : namePrefix;
    return `${base}#${encodeURIComponent(newName)}`;
  }
  if (link.startsWith('vmess://')) {
    try {
      const base64Part = link.substring('vmess://'.length);
      const binaryString = atob(base64Part);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
      }
      const jsonString = new TextDecoder('utf-8').decode(bytes);
      const nodeConfig = JSON.parse(jsonString);
      const originalPs = nodeConfig.ps || '';
      if (!originalPs.startsWith(prefix)) {
        nodeConfig.ps = originalPs ? `${prefix} - ${originalPs}` : prefix;
      }
      const newJsonString = JSON.stringify(nodeConfig);
      const newBase64Part = btoa(unescape(encodeURIComponent(newJsonString)));
      return 'vmess://' + newBase64Part;
    } catch (e) {
      console.error("为 vmess 节点添加名称前缀失败，将回退到通用方法。", e);
      return appendToFragment(link, prefix);
    }
  }
  return appendToFragment(link, prefix);
}

async function generateCombinedNodeList(context, config, userAgent, misubs, prependedContent = '') {
    const nodeRegex = /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy|hy2|tuic|anytls|socks5):\/\//;
    let manualNodesContent = '';
    const normalizeVmessLink = (link) => {
        if (!link.startsWith('vmess://')) return link;
        try {
            const base64Part = link.substring('vmess://'.length);
            const binaryString = atob(base64Part);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
            const jsonString = new TextDecoder('utf-8').decode(bytes);
            const compactJsonString = JSON.stringify(JSON.parse(jsonString));
            const newBase64Part = btoa(unescape(encodeURIComponent(compactJsonString)));
            return 'vmess://' + newBase64Part;
        } catch (e) {
            console.error("标准化 vmess 链接失败，将使用原始链接:", link, e);
            return link;
        }
    };
    const httpSubs = misubs.filter(sub => {
        if (sub.url.toLowerCase().startsWith('http')) return true;
        manualNodesContent += sub.url + '\n';
        return false;
    });
    const processedManualNodes = manualNodesContent.split('\n')
        .map(line => line.trim())
        .filter(line => nodeRegex.test(line))
        .map(normalizeVmessLink)
        .map(node => (config.prependSubName) ? prependNodeName(node, '手动节点') : node)
        .join('\n');
    const subPromises = httpSubs.map(async (sub) => {
        try {
            const requestHeaders = { 'User-Agent': userAgent };
            const response = await Promise.race([
                fetch(new Request(sub.url, { headers: requestHeaders, redirect: "follow", cf: { insecureSkipVerify: true } })),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 10000))
            ]);
            if (!response.ok) return '';
            let text = await response.text();
            try {
                const cleanedText = text.replace(/\s/g, '');
                if (cleanedText.length > 20 && /^[A-Za-z0-9+/=]+$/.test(cleanedText)) {
                    const binaryString = atob(cleanedText);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) { bytes[i] = binaryString.charCodeAt(i); }
                    text = new TextDecoder('utf-8').decode(bytes);
                }
            } catch (e) {}
            let validNodes = text.replace(/\r\n/g, '\n').split('\n')
                .map(line => line.trim()).filter(line => nodeRegex.test(line));

            if (sub.exclude && sub.exclude.trim() !== '') {
                const rules = sub.exclude.trim().split('\n').map(r => r.trim()).filter(Boolean);
                const keepRules = rules.filter(r => r.toLowerCase().startsWith('keep:'));

                if (keepRules.length > 0) {
                    const nameRegexParts = [];
                    const protocolsToKeep = new Set();
                    keepRules.forEach(rule => {
                        const content = rule.substring('keep:'.length).trim();
                        if (content.toLowerCase().startsWith('proto:')) {
                            const protocols = content.substring('proto:'.length).split(',').map(p => p.trim().toLowerCase());
                            protocols.forEach(p => protocolsToKeep.add(p));
                        } else {
                            nameRegexParts.push(content);
                        }
                    });
                    const nameRegex = nameRegexParts.length > 0 ? new RegExp(nameRegexParts.join('|'), 'i') : null;
                    validNodes = validNodes.filter(nodeLink => {
                        const protocolMatch = nodeLink.match(/^(.*?):\/\//);
                        const protocol = protocolMatch ? protocolMatch[1].toLowerCase() : '';
                        if (protocolsToKeep.has(protocol)) {
                            return true;
                        }
                        if (nameRegex) {
                            const hashIndex = nodeLink.lastIndexOf('#');
                            if (hashIndex !== -1) {
                                try {
                                    const nodeName = decodeURIComponent(nodeLink.substring(hashIndex + 1));
                                    if (nameRegex.test(nodeName)) {
                                        return true;
                                    }
                                } catch (e) { /* 忽略解码错误 */ }
                            }
                        }
                        return false;
                    });
                } else {
                    const protocolsToExclude = new Set();
                    const nameRegexParts = [];
                    rules.forEach(rule => {
                        if (rule.toLowerCase().startsWith('proto:')) {
                            const protocols = rule.substring('proto:'.length).split(',').map(p => p.trim().toLowerCase());
                            protocols.forEach(p => protocolsToExclude.add(p));
                        } else {
                            nameRegexParts.push(rule);
                        }
                    });
                    const nameRegex = nameRegexParts.length > 0 ? new RegExp(nameRegexParts.join('|'), 'i') : null;
                    validNodes = validNodes.filter(nodeLink => {
                        const protocolMatch = nodeLink.match(/^(.*?):\/\//);
                        const protocol = protocolMatch ? protocolMatch[1].toLowerCase() : '';
                        if (protocolsToExclude.has(protocol)) {
                            return false;
                        }
                        if (nameRegex) {
                            const hashIndex = nodeLink.lastIndexOf('#');
                            if (hashIndex !== -1) {
                                try {
                                    const nodeName = decodeURIComponent(nodeLink.substring(hashIndex + 1));
                                    if (nameRegex.test(nodeName)) {
                                        return false;
                                    }
                                } catch (e) { /* 忽略解码错误 */ }
                            }
                        }
                        return true;
                    });
                }
            }
            return (config.prependSubName && sub.name)
                ? validNodes.map(node => prependNodeName(node, sub.name)).join('\n')
                : validNodes.join('\n');
        } catch (e) { return ''; }
    });
    const processedSubContents = await Promise.all(subPromises);
    const combinedContent = (processedManualNodes + '\n' + processedSubContents.join('\n'));
    const uniqueNodesString = [...new Set(combinedContent.split('\n').map(line => line.trim()).filter(line => line))].join('\n');

    if (prependedContent) {
        return `${prependedContent}\n${uniqueNodesString}`;
    }
    return uniqueNodesString;
}

async function handleMisubRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const userAgentHeader = request.headers.get('User-Agent') || "Unknown";

    const [settingsData, misubsData, profilesData] = await Promise.all([
        env.MISUB_KV.get(KV_KEY_SETTINGS, 'json'),
        env.MISUB_KV.get(KV_KEY_SUBS, 'json'),
        env.MISUB_KV.get(KV_KEY_PROFILES, 'json')
    ]);
    const settings = settingsData || {};
    const allMisubs = misubsData || [];
    const allProfiles = profilesData || [];
    const config = { ...defaultSettings, ...settings };

    let token = '';
    let profileIdentifier = null;
    const pathSegments = url.pathname.replace(/^\/sub\//, '/').split('/').filter(Boolean);

    if (pathSegments.length > 0) {
        token = pathSegments[0];
        if (pathSegments.length > 1) {
            profileIdentifier = pathSegments[1];
        }
    } else {
        token = url.searchParams.get('token');
    }

    let targetMisubs;
    let subName = config.FileName;
    let effectiveSubConverter;
    let effectiveSubConfig;

    if (profileIdentifier) {
        if (!token || token !== config.profileToken) {
            return new Response('无效的 Profile Token', { status: 403 });
        }
        const profile = allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier);
        if (profile && profile.enabled) {
            subName = profile.name;
            const profileSubIds = new Set(profile.subscriptions);
            const profileNodeIds = new Set(profile.manualNodes);
            targetMisubs = allMisubs.filter(item => {
                if (item.url.startsWith('http')) {
                    return item.enabled && profileSubIds.has(item.id);
                }
                return item.enabled && profileNodeIds.has(item.id);
            });
            effectiveSubConverter = profile.subConverter && profile.subConverter.trim() !== '' ? profile.subConverter : config.subConverter;
            effectiveSubConfig = profile.subConfig && profile.subConfig.trim() !== '' ? profile.subConfig : config.subConfig;
        } else {
            return new Response('订阅组未找到或已禁用', { status: 404 });
        }
    } else {
        if (!token || token !== config.mytoken) {
            return new Response('无效的 Token', { status: 403 });
        }
        targetMisubs = allMisubs.filter(s => s.enabled);
        effectiveSubConverter = config.subConverter;
        effectiveSubConfig = config.subConfig;
    }

    if (!effectiveSubConverter || effectiveSubConverter.trim() === '') {
        return new Response('Subconverter 后端未配置。', { status: 500 });
    }

    let targetFormat = url.searchParams.get('target');
    if (!targetFormat) {
        const supportedFormats = ['clash', 'singbox', 'surge', 'loon', 'base64', 'v2ray', 'trojan'];
        for (const format of supportedFormats) {
            if (url.searchParams.has(format)) {
                if (format === 'v2ray' || format === 'trojan') { targetFormat = 'base64'; } else { targetFormat = format; }
                break;
            }
        }
    }
    if (!targetFormat) {
        const ua = userAgentHeader.toLowerCase();
        const uaMapping = [
            ['flyclash', 'clash'], ['mihomo', 'clash'], ['clash.meta', 'clash'],
            ['clash-verge', 'clash'], ['meta', 'clash'], ['stash', 'clash'],
            ['nekoray', 'clash'], ['sing-box', 'singbox'], ['shadowrocket', 'base64'],
            ['v2rayn', 'base64'], ['v2rayng', 'base64'], ['surge', 'surge'],
            ['loon', 'loon'], ['quantumult%20x', 'quanx'], ['quantumult', 'quanx'],
            ['clash', 'clash']
        ];
        for (const [keyword, format] of uaMapping) {
            if (ua.includes(keyword)) {
                targetFormat = format;
                break;
            }
        }
    }
    if (!targetFormat) { targetFormat = 'clash'; }

    const clientIp = request.headers.get('CF-Connecting-IP') || 'N/A';
    const country = request.headers.get('CF-IPCountry') || 'N/A';
    let message = `🛰️ *订阅被访问* 🛰️\n\n*客户端:* \`${userAgentHeader}\`\n*IP 地址:* \`${clientIp} (${country})\`\n*请求格式:* \`${targetFormat}\``;
    if (profileIdentifier) { message += `\n*订阅组:* \`${subName}\``; }
    context.waitUntil(sendTgNotification(config, message));

    let fakeNodeString = '';
    const totalRemainingBytes = targetMisubs.reduce((acc, sub) => {
        if (sub.enabled && sub.userInfo && sub.userInfo.total > 0) {
            const used = (sub.userInfo.upload || 0) + (sub.userInfo.download || 0);
            const remaining = sub.userInfo.total - used;
            return acc + Math.max(0, remaining);
        }
        return acc;
    }, 0);
    if (totalRemainingBytes > 0) {
        const formattedTraffic = formatBytes(totalRemainingBytes);
        const fakeNodeName = `流量剩余 ≫ ${formattedTraffic}`;
        fakeNodeString = `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(fakeNodeName)}`;
    }

    const combinedNodeList = await generateCombinedNodeList(context, config, userAgentHeader, targetMisubs, fakeNodeString);
    const base64Content = btoa(unescape(encodeURIComponent(combinedNodeList)));

    if (targetFormat === 'base64') {
        const headers = { "Content-Type": "text/plain; charset=utf-8", 'Cache-Control': 'no-store, no-cache' };
        return new Response(base64Content, { headers });
    }

    const dataUri = `data:text/plain;base64,${base64Content}`;

    const subconverterUrl = new URL(`https://${effectiveSubConverter}/sub`);
    subconverterUrl.searchParams.set('target', targetFormat);
    subconverterUrl.searchParams.set('url', dataUri); 

    if ((targetFormat === 'clash' || targetFormat === 'loon' || targetFormat === 'surge') && effectiveSubConfig && effectiveSubConfig.trim() !== '') {
        subconverterUrl.searchParams.set('config', effectiveSubConfig);
    }
    subconverterUrl.searchParams.set('new_name', 'true');
    
    try {
        const subconverterResponse = await fetch(subconverterUrl.toString(), {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (!subconverterResponse.ok) {
            const errorBody = await subconverterResponse.text();
            throw new Error(`Subconverter 服务返回状态: ${subconverterResponse.status}. Body: ${errorBody}`);
        }
        const responseText = await subconverterResponse.text();
        const responseHeaders = new Headers(subconverterResponse.headers);
        responseHeaders.set("Content-Disposition", `attachment; filename*=utf-8''${encodeURIComponent(subName)}`);
        responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
        responseHeaders.set('Cache-Control', 'no-store, no-cache');
        return new Response(responseText, { status: subconverterResponse.status, statusText: subconverterResponse.statusText, headers: responseHeaders });
    } catch (error) {
        console.error(`[MiSub 最终错误] ${error.message}`);
        return new Response(`连接 subconverter 时出错: ${error.message}`, { status: 502 });
    }
}

export async function onRequest(context) {
    const { request, env, next } = context;
    const url = new URL(request.url);

    if (request.headers.get("cf-cron")) {
        return handleCronTrigger(env);
    }

    if (url.pathname.startsWith('/api/')) {
        return handleApiRequest(request, env);
    }
    const isStaticAsset = /^\/(assets|@vite|src)\//.test(url.pathname) || /\.\w+$/.test(url.pathname);
    if (!isStaticAsset && url.pathname !== '/') {
        return handleMisubRequest(context);
    }
    return next();
}
