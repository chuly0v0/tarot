/*
 * 咪的天离线资源缓存。
 * 发布了新的图片、字体或视频后，请递增版本号，
 * 浏览器就会在后台建立一份完整的新缓存，再安全替换旧缓存。
 */
const CACHE_VERSION = 'v2';
const CACHE_NAME = `meow-tarot-${CACHE_VERSION}`;
const TOTAL_ASSET_BYTES = 22588194;

const CORE_ASSETS = [
    './assets/fonts/SourceHanSerif.otf',
    './assets/img/card_back.jpg',
    './assets/img/card_stack.webp',
    './assets/img/first_frame/home_first.webp',
    './assets/img/first_frame/a1_a2_first.webp',
    './assets/img/first_frame/a3_a4_first.webp',
    './assets/img/first_frame/b_first.webp',
    './assets/video/home_bg.mp4',
    './assets/video/a1_a2_bg.mp4',
    './assets/video/a3_a4_bg.mp4',
    './assets/video/b_bg.mp4'
];

const CARD_ASSETS = Array.from(
    { length: 80 },
    (_, index) => `./assets/img/cards/${index + 1}.jpg`
);

const APP_ASSETS = [...CORE_ASSETS, ...CARD_ASSETS];

async function notifyClients(message) {
    const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
    });
    clients.forEach(client => client.postMessage(message));
}

async function cacheAllAssets() {
    const cache = await caches.open(CACHE_NAME);
    let completed = 0;
    let nextIndex = 0;

    // 手机端限制并发数，避免蜂窝网络抖动和内存峰值导致请求失败。
    async function worker() {
        while (nextIndex < APP_ASSETS.length) {
            const assetIndex = nextIndex++;
            const asset = APP_ASSETS[assetIndex];
            let response;
            let lastError;

            // 手机网络偶尔会丢失单个请求；最多重试两次，避免整批缓存因此失败。
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    response = await fetch(new Request(asset, { cache: 'no-cache' }));
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    break;
                } catch (error) {
                    lastError = error;
                    if (attempt < 3) {
                        await new Promise(resolve => setTimeout(resolve, attempt * 600));
                    }
                }
            }

            if (!response?.ok) {
                throw new Error(`无法缓存 ${asset}（${lastError?.message || '网络错误'}）`);
            }

            await cache.put(asset, response);
            completed += 1;
            await notifyClients({
                type: 'CACHE_PROGRESS',
                completed,
                total: APP_ASSETS.length,
                totalBytes: TOTAL_ASSET_BYTES
            });
        }
    }

    await Promise.all(Array.from({ length: 4 }, () => worker()));
}

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        try {
            await cacheAllAssets();
            await notifyClients({
                type: 'CACHE_READY',
                completed: APP_ASSETS.length,
                total: APP_ASSETS.length,
                totalBytes: TOTAL_ASSET_BYTES
            });
            await self.skipWaiting();
        } catch (error) {
            await caches.delete(CACHE_NAME);
            await notifyClients({
                type: 'CACHE_ERROR',
                message: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(
            cacheNames
                .filter(name => name.startsWith('meow-tarot-') && name !== CACHE_NAME)
                .map(name => caches.delete(name))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('message', event => {
    if (event.data?.type !== 'GET_CACHE_STATUS') return;

    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        const matches = await Promise.all(
            APP_ASSETS.map(asset => cache.match(asset))
        );
        const completed = matches.filter(Boolean).length;
        const message = {
            type: completed === APP_ASSETS.length ? 'CACHE_READY' : 'CACHE_PROGRESS',
            completed,
            total: APP_ASSETS.length,
            totalBytes: TOTAL_ASSET_BYTES
        };

        if (event.ports[0]) {
            event.ports[0].postMessage(message);
        } else if (event.source) {
            event.source.postMessage(message);
        }
    })());
});

async function responseForRangeRequest(request, cachedResponse) {
    const rangeHeader = request.headers.get('range');
    const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader || '');
    if (!match) return cachedResponse;

    const body = await cachedResponse.arrayBuffer();
    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : body.byteLength - 1;
    const end = Math.min(requestedEnd, body.byteLength - 1);

    if (start >= body.byteLength || start > end) {
        return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${body.byteLength}` }
        });
    }

    const headers = new Headers(cachedResponse.headers);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(end - start + 1));
    headers.set('Content-Range', `bytes ${start}-${end}/${body.byteLength}`);

    return new Response(body.slice(start, end + 1), {
        status: 206,
        statusText: 'Partial Content',
        headers
    });
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        // HTML 优先联网，便于 GitHub Pages 发布的新代码及时生效；断网时回退旧页面。
        event.respondWith(
            fetch(request).catch(async () =>
                (await caches.match('./index.html')) || (await caches.match('./'))
            )
        );
        return;
    }

    event.respondWith((async () => {
        const cached = await caches.match(request, { ignoreVary: true });
        if (cached) {
            if (request.headers.has('range')) {
                return responseForRangeRequest(request, cached);
            }
            return cached;
        }

        // 不在预缓存清单中的同源资源仍可正常联网加载。
        return fetch(request);
    })());
});
