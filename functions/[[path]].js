import yaml from 'js-yaml';

// --- 全局常量 ---
const KV_KEY_SUBS = 'misub_subscriptions_v1';
const KV_KEY_PROFILES = 'misub_profiles_v1';
const KV_KEY_SETTINGS = 'worker_settings_v1';
const OLD_KV_KEY = 'misub_data_v1'; // 用於數據遷移
const COOKIE_NAME = 'auth_session';
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 小時

// 系統的默認設置，當用戶未配置時作為備用
const defaultSettings = {
  FileName: 'MiSub',
  mytoken: 'auto',
  subConverter: 'subapi.cmliussss.net', 
  subConfig: 'https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini',
  prependSubName: true
};

// --- 核心輔助函數 ---

/**
 * 創建一個帶有簽名的 token
 * @param {string} key - 用於簽名的密鑰 (COOKIE_SECRET)
 * @param {string} data - 要簽名的數據 (通常是時間戳)
 * @returns {Promise<string>} - 返回 "數據.簽名" 格式的字符串
 */
async function createSignedToken(key, data) {
    if (!key || !data) throw new Error("Key and data are required for signing.");
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const dataToSign = encoder.encode(data);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataToSign);
    return `${data}.${Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 驗證簽名 token 的有效性
 * @param {string} key - 用於驗證的密鑰
 * @param {string} token - 要驗證的 token
 * @returns {Promise<string|null>} - 如果驗證成功，返回原始數據；否則返回 null
 */
async function verifySignedToken(key, token) {
    if (!key || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [data] = parts;
    const expectedToken = await createSignedToken(key, data);
    return token === expectedToken ? data : null;
}

/**
 * 認證中間件，檢查請求 cookie 的有效性
 * @param {Request} request - 傳入的請求
 * @param {object} env - 環境變量
 * @returns {Promise<boolean>} - 返回是否認證成功
 */
async function authMiddleware(request, env) {
    if (!env.COOKIE_SECRET) return false;
    const cookie = request.headers.get('Cookie');
    const sessionCookie = cookie?.split(';').find(c => c.trim().startsWith(`${COOKIE_NAME}=`));
    if (!sessionCookie) return false;
    const token = sessionCookie.split('=')[1];
    const verifiedData = await verifySignedToken(env.COOKIE_SECRET, token);
    return verifiedData && (Date.now() - parseInt(verifiedData, 10) < SESSION_DURATION);
}


// --- API 請求處理 ---

/**
 * 處理所有 /api/ 開頭的請求
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handleApiRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');

    // 數據遷移接口
    if (path === '/migrate') {
        if (!await authMiddleware(request, env)) { return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }); }
        try {
            const oldData = await env.MISUB_KV.get(OLD_KV_KEY, 'json');
            const newDataExists = await env.MISUB_KV.get(KV_KEY_SUBS) !== null;

            if (newDataExists) return new Response(JSON.stringify({ success: true, message: '无需迁移，数据已是最新结构。' }), { status: 200 });
            if (!oldData) return new Response(JSON.stringify({ success: false, message: '未找到需要迁移的旧数据。' }), { status: 404 });
            
            await env.MISUB_KV.put(KV_KEY_SUBS, JSON.stringify(oldData));
            await env.MISUB_KV.put(KV_KEY_PROFILES, JSON.stringify([]));
            await env.MISUB_KV.put(OLD_KV_KEY + '_migrated_on_' + new Date().toISOString(), JSON.stringify(oldData));
            await env.MISUB_KV.delete(OLD_KV_KEY);

            return new Response(JSON.stringify({ success: true, message: '数据迁移成功！' }), { status: 200 });
        } catch (e) {
            return new Response(JSON.stringify({ success: false, message: `迁移失败: ${e.message}` }), { status: 500 });
        }
    }

    // 除登录外，其他接口都需要认证
    if (path !== '/login') {
        if (!await authMiddleware(request, env)) { return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }); }
    }

    try {
        switch (path) {
            case '/login': {
                if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
                const { password } = await request.json();
                if (password === env.ADMIN_PASSWORD) {
                    const token = await createSignedToken(env.COOKIE_SECRET, String(Date.now()));
                    const headers = new Headers({ 'Content-Type': 'application/json' });
                    headers.append('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION / 1000}`);
                    return new Response(JSON.stringify({ success: true }), { headers });
                }
                return new Response(JSON.stringify({ error: '密码错误' }), { status: 401 });
            }
            case '/logout': {
                const headers = new Headers({ 'Content-Type': 'application/json' });
                headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
                return new Response(JSON.stringify({ success: true }), { headers });
            }
            case '/data': {
                // 健壯性處理：如果 KV.get 返回 null (鍵不存在), 則使用 || [] 來確保得到的是一個空數組，防止崩潰
                const [misubs, profiles, settings] = await Promise.all([
                    env.MISUB_KV.get(KV_KEY_SUBS, 'json').then(res => res || []),
                    env.MISUB_KV.get(KV_KEY_PROFILES, 'json').then(res => res || []),
                    env.MISUB_KV.get(KV_KEY_SETTINGS, 'json').then(res => res || {})
                ]);
                const config = { FileName: settings.FileName || 'MISUB', mytoken: settings.mytoken || 'auto' };
                return new Response(JSON.stringify({ misubs, profiles, config }), { headers: { 'Content-Type': 'application/json' } });
            }
            case '/misubs': {
                const { misubs, profiles } = await request.json();
                if (typeof misubs === 'undefined' || typeof profiles === 'undefined') {
                    return new Response(JSON.stringify({ success: false, message: '请求体中缺少 misubs 或 profiles 字段' }), { status: 400 });
                }
                await Promise.all([
                    env.MISUB_KV.put(KV_KEY_SUBS, JSON.stringify(misubs)),
                    env.MISUB_KV.put(KV_KEY_PROFILES, JSON.stringify(profiles))
                ]);
                return new Response(JSON.stringify({ success: true, message: '订阅源及订阅组已保存' }));
            }
            case '/node_count': {
                if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
                const { url: subUrl } = await request.json();
                if (!subUrl || typeof subUrl !== 'string' || !/^https?:\/\//.test(subUrl)) {
                    return new Response(JSON.stringify({ error: 'Invalid or missing url' }), { status: 400 });
                }
                const result = { count: 0, userInfo: null };
                try {
                    const trafficRequest = fetch(new Request(subUrl, { headers: { 'User-Agent': 'Clash for Windows/0.20.39' }, redirect: "follow" }));
                    const nodeCountRequest = fetch(new Request(subUrl, { headers: { 'User-Agent': 'MiSub-Node-Counter/2.0' }, redirect: "follow" }));
                    const [trafficResponse, nodeCountResponse] = await Promise.all([trafficRequest, nodeCountRequest]);
                    if (trafficResponse.ok) {
                        const userInfoHeader = trafficResponse.headers.get('subscription-userinfo');
                        if (userInfoHeader) {
                            const info = {};
                            userInfoHeader.split(';').forEach(part => {
                                const [key, value] = part.trim().split('=');
                                if (key && value) info[key] = /^\d+$/.test(value) ? Number(value) : value;
                            });
                            result.userInfo = info;
                        }
                    }
                    if (nodeCountResponse.ok) {
                        const text = await nodeCountResponse.text();
                        let decoded = '';
                        try { decoded = atob(text.replace(/\s/g, '')); } catch { decoded = text; }
                        const lineMatches = decoded.match(/^(ss|ssr|vmess|vless|trojan|hysteria2?):\/\//gm);
                        if (lineMatches) result.count = lineMatches.length;
                    }
                } catch (e) {
                    console.error('Failed to fetch subscription with dual-request method:', e);
                }
                return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
            }
            case '/settings': {
                if (request.method === 'GET') {
                    const settings = await env.MISUB_KV.get(KV_KEY_SETTINGS, 'json') || {};
                    return new Response(JSON.stringify({ ...defaultSettings, ...settings }), { headers: { 'Content-Type': 'application/json' } });
                }
                if (request.method === 'POST') {
                    const newSettings = await request.json();
                    const oldSettings = await env.MISUB_KV.get(KV_KEY_SETTINGS, 'json') || {};
                    const finalSettings = { ...oldSettings, ...newSettings };
                    await env.MISUB_KV.put(KV_KEY_SETTINGS, JSON.stringify(finalSettings));
                    await sendTgNotification(finalSettings, `🎉 MiSub 設定已成功更新！`);
                    return new Response(JSON.stringify({ success: true, message: '设置已保存' }));
                }
                return new Response('Method Not Allowed', { status: 405 });
            }
            default:
                return new Response('API route not found', { status: 404 });
        }
    } catch (e) { 
        console.error("API Error:", e);
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: e.message }), { status: 500 });
    }
}


// --- 订阅生成相关函数 ---

/**
 * 为节点链接添加名称前缀 (vmess特殊处理，其他协议通用处理)
 * @param {string} link 
 * @param {string} prefix 
 * @returns {string}
 */
function prependNodeName(link, prefix) {
    if (!prefix) return link;
    const appendToFragment = (baseLink, namePrefix) => {
        const hashIndex = baseLink.lastIndexOf('#');
        const originalName = hashIndex !== -1 ? decodeURIComponent(baseLink.substring(hashIndex + 1)) : '';
        const base = hashIndex !== -1 ? baseLink.substring(0, hashIndex) : baseLink;
        if (originalName.startsWith(namePrefix)) return baseLink;
        const newName = originalName ? `${namePrefix} - ${originalName}` : namePrefix;
        return `${base}#${encodeURIComponent(newName)}`;
    };
    if (link.startsWith('vmess://')) {
        try {
            const base64Part = link.substring('vmess://'.length);
            const binaryString = atob(base64Part);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
            const jsonString = new TextDecoder('utf-8').decode(bytes);
            const nodeConfig = JSON.parse(jsonString);
            const originalPs = nodeConfig.ps || '';
            if (!originalPs.startsWith(prefix)) nodeConfig.ps = originalPs ? `${prefix} - ${originalPs}` : prefix;
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

/**
 * 抓取所有启用的订阅和节点，合并成一个单一的节点列表字符串
 * @param {object} context 
 * @param {object} config 
 * @param {string} userAgent 
 * @param {Array} misubs - 已筛选过的、需要合并的订阅和节点列表
 * @returns {Promise<string>}
 */
async function generateCombinedNodeList(context, config, userAgent, misubs) {
    const nodeRegex = /^(ss|ssr|vmess|vless|trojan|hysteria2?):\/\//;
    let manualNodesContent = '';

    const httpSubs = misubs.filter(sub => {
        if (sub.url.toLowerCase().startsWith('http')) return true;
        manualNodesContent += sub.url + '\n';
        return false;
    });

    const processedManualNodes = manualNodesContent.split('\n').map(line => line.trim())
        .filter(line => nodeRegex.test(line))
        .map(node => (config.prependSubName) ? prependNodeName(node, '手动节点') : node)
        .join('\n');

    const subPromises = httpSubs.map(async (sub) => {
        try {
            const response = await fetch(new Request(sub.url, { headers: { 'User-Agent': userAgent }, redirect: "follow" }));
            if (!response.ok) return '';
            
            let text = await response.text();
            try {
                const cleanedText = text.replace(/\s/g, '');
                if (cleanedText.length > 20 && /^[A-Za-z0-9+/=]+$/.test(cleanedText)) {
                    const binaryString = atob(cleanedText);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
                    text = new TextDecoder('utf-8').decode(bytes);
                }
            } catch (e) {}
            
            return text.replace(/\r\n/g, '\n').split('\n').map(line => line.trim())
                .filter(line => nodeRegex.test(line))
                .map(node => (config.prependSubName && sub.name) ? prependNodeName(node, sub.name) : node)
                .join('\n');
        } catch (e) { 
            console.error(`Failed to fetch sub: ${sub.url}`, e);
            return ''; 
        }
    });

    const processedSubContents = await Promise.all(subPromises);
    const combinedContent = (processedManualNodes + '\n' + processedSubContents.join('\n'));
    return [...new Set(combinedContent.split('\n').map(line => line.trim()).filter(line => line))].join('\n');
}

/**
 * 生成一个固定的、用于 subconverter 回调的 token
 * @param {object} env 
 * @returns {Promise<string>}
 */
async function getCallbackToken(env) {
    const secret = env.COOKIE_SECRET || 'default-callback-secret';
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode('callback-static-data'));
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}


/**
 * 處理所有訂閱請求
 * @param {object} context
 * @returns {Promise<Response>}
 */
async function handleMisubRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const userAgentHeader = request.headers.get('User-Agent') || "Unknown";

    const [settings, allMisubs, allProfiles] = await Promise.all([
        env.MISUB_KV.get(KV_KEY_SETTINGS, 'json').then(res => res || {}),
        env.MISUB_KV.get(KV_KEY_SUBS, 'json').then(res => res || []),
        env.MISUB_KV.get(KV_KEY_PROFILES, 'json').then(res => res || [])
    ]);
    
    const config = { ...defaultSettings, ...settings };

    let token = '';
    let profileId = null;
    const pathSegments = url.pathname.split('/').filter(Boolean);

    if (pathSegments.length > 1 && pathSegments[0] === 'sub') {
        token = pathSegments[1];
        if (pathSegments.length > 2) profileId = pathSegments[2];
    } else {
        token = url.searchParams.get('token');
    }

    if (!token || token !== config.mytoken) {
        return new Response('Invalid token', { status: 403 });
    }

    let targetMisubs;
    let subName = config.FileName; 

    if (profileId) {
        const profile = allProfiles.find(p => p.id === profileId && p.enabled);
        if (profile) {
            subName = profile.name;
            const profileSubIds = new Set(profile.subscriptions);
            const profileNodeIds = new Set(profile.manualNodes);
            targetMisubs = allMisubs.filter(item => 
                (item.url.startsWith('http') ? profileSubIds.has(item.id) : profileNodeIds.has(item.id))
            );
        } else {
            return new Response('Profile not found or disabled', { status: 404 });
        }
    } else {
        targetMisubs = allMisubs.filter(s => s.enabled);
    }
    
    let targetFormat = url.searchParams.get('target') || 'base64';
    if (!url.searchParams.has('target')) {
        const ua = userAgentHeader.toLowerCase();
        if (ua.includes('clash')) targetFormat = 'clash';
        else if (ua.includes('sing-box')) targetFormat = 'singbox';
    }

    const combinedNodeList = await generateCombinedNodeList(context, config, userAgentHeader, targetMisubs);
    const base64Content = btoa(unescape(encodeURIComponent(combinedNodeList)));

    if (targetFormat === 'base64') {
        return new Response(base64Content, { headers: { "Content-Type": "text/plain; charset=utf-8", 'Cache-Control': 'no-store, no-cache' } });
    }
    
    const callbackToken = await getCallbackToken(env);
    const callbackPath = profileId ? `/sub/${token}/${profileId}` : `/sub/${token}`;
    const callbackUrl = `${url.protocol}//${url.host}${callbackPath}?target=base64&callback_token=${callbackToken}`;
    
    if (url.searchParams.get('callback_token') === callbackToken) {
        return new Response(base64Content, { headers: { "Content-Type": "text/plain; charset=utf-8", 'Cache-Control': 'no-store, no-cache' } });
    }
    
    const subconverterUrl = new URL(`https://${config.subConverter}/sub`);
    subconverterUrl.searchParams.set('target', targetFormat);
    subconverterUrl.searchParams.set('url', callbackUrl);
    
    // 健壮地选择 subconverter 配置，如果用户设置为空，则强制回退到默认
    const subconverterConfigUrl = config.subConfig || defaultSettings.subConfig;
    subconverterUrl.searchParams.set('config', subconverterConfigUrl);
    
    subconverterUrl.searchParams.set('new_name', 'true');

    try {
        const subconverterResponse = await fetch(subconverterUrl.toString(), { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!subconverterResponse.ok) throw new Error(`Subconverter service returned status: ${subconverterResponse.status}`);
        
        let responseText = await subconverterResponse.text();
        
        if (targetFormat === 'clash') {
            responseText = responseText.replace(/^Proxy:/m, 'proxies:').replace(/^Proxy Group:/m, 'proxy-groups:').replace(/^Rule:/m, 'rules:');
        }

        const responseHeaders = new Headers(subconverterResponse.headers);
        responseHeaders.set("Content-Disposition", `attachment; filename*=utf-8''${encodeURIComponent(subName)}`);
        responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
        responseHeaders.set('Cache-Control', 'no-store, no-cache');

        return new Response(responseText, { status: subconverterResponse.status, statusText: subconverterResponse.statusText, headers: responseHeaders });
    } catch (error) {
        console.error(`[MiSub Final Error] ${error.message}`);
        return new Response(`Error connecting to subconverter: ${error.message}`, { status: 502 });
    }
}


// --- Cloudflare Pages Functions 主入口 ---
export async function onRequest(context) {
    const { request, env, next } = context;
    const url = new URL(request.url);
    try {
        if (url.pathname.startsWith('/api/')) {
            return handleApiRequest(request, env);
        }

        // 新的订阅链接路由, e.g. /sub/your-token or /sub/your-token/profile-id
        if (url.pathname.startsWith('/sub/')) {
            return handleMisubRequest(context);
        }

        // 兼容旧的订阅链接格式 /{token}
        if (url.pathname !== '/' && !url.pathname.includes('.') && !url.pathname.startsWith('/assets')) {
            const newPath = `/sub${url.pathname}`;
            const newUrl = new URL(newPath + url.search, url.origin);
            const newRequest = new Request(newUrl, request);
            const newContext = { ...context, request: newRequest };
            return handleMisubRequest(newContext);
        }

        // 静态资源或首页
        return next();
    } catch (e) {
        console.error("Critical error in onRequest:", e);
        return new Response("Internal Server Error", { status: 500 });
    }
}