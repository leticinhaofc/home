// Service Worker para proxy de vídeo seguro e caching inteligente (YouTube style)

const CACHE_NAME = 'video-cache';
const META_CACHE_NAME = 'app-meta';
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024; // Limite de 50MB para caching em background

let googleApiKey = '';
const activeDownloads = new Set();

// Ativação imediata do Service Worker
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Recebe mensagens da aplicação (ex: chave de API)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SET_API_KEY') {
    googleApiKey = event.data.apiKey;
    
    // Persiste a chave no cache de metadados para durabilidade ou limpa se vazia
    event.waitUntil(
      caches.open(META_CACHE_NAME).then((cache) => {
        if (!googleApiKey) {
          return cache.delete('/api-key');
        }
        return cache.put('/api-key', new Response(googleApiKey));
      })
    );
  }
});

// Recupera a chave de API persistida se ela sumir da memória
async function getStoredApiKey() {
  if (googleApiKey) return googleApiKey;
  try {
    const cache = await caches.open(META_CACHE_NAME);
    const response = await cache.match('/api-key');
    if (response) {
      googleApiKey = await response.text();
    }
  } catch (err) {
    console.warn('Erro ao recuperar chave de API persistida no SW:', err);
  }
  return googleApiKey;
}

// Interceptador de rede principal
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Intercepta requisições de proxy de vídeo de mesma origem
  if (url.pathname.startsWith('/sw-video/')) {
    event.respondWith(handleVideoRequest(event));
  }
});

// Manipula a requisição do reprodutor de vídeo
async function handleVideoRequest(event) {
  const url = new URL(event.request.url);
  const pathParts = url.pathname.split('/');
  const fileId = pathParts[2]; // /sw-video/{fileId}
  
  if (!fileId) {
    return fetch(event.request);
  }

  const apiKey = await getStoredApiKey();
  if (!apiKey) {
    console.warn('Chave de API do Google Drive não configurada no Service Worker. Prosseguindo via CDN...');
  }

  const cacheKey = `/sw-video/${fileId}`;
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(cacheKey);

  const googleDriveUrl = `https://lh3.googleusercontent.com/d/${fileId}`;

  // Se já estiver no cache local completo, responde fatiando o vídeo
  if (cachedResponse) {
    const rangeHeader = event.request.headers.get('Range');
    if (rangeHeader) {
      return serveRangeFromCachedResponse(cachedResponse, rangeHeader);
    }
    return cachedResponse.clone();
  }

  // Se não estiver no cache: streaming progressivo on-demand (YouTube Style)
  const rangeHeader = event.request.headers.get('Range');
  const headers = new Headers();
  
  // Repassa o cabeçalho Range (se houver) para buscar apenas o pedaço necessário
  if (rangeHeader) {
    headers.set('Range', rangeHeader);
  }

  try {
    const response = await fetch(googleDriveUrl, { headers });

    // Se for o início do vídeo (bytes=0-1), verifica se vale a pena cachear em background
    if (response.ok || response.status === 206) {
      const contentRange = response.headers.get('Content-Range');
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        if (match) {
          const totalSize = parseInt(match[1], 10);
          
          // Apenas dispara download em background para arquivos abaixo de 50MB
          if (totalSize <= MAX_CACHE_SIZE_BYTES) {
            triggerBackgroundDownload(fileId, googleDriveUrl);
          }
        }
      }
    }

    return response;
  } catch (error) {
    console.error('Erro ao buscar vídeo do Drive no Service Worker:', error);
    // Caso falhe de vez, tenta buscar a requisição original
    return fetch(event.request);
  }
}

// Executa o download assíncrono completo em segundo plano e armazena em cache
function triggerBackgroundDownload(fileId, googleDriveUrl) {
  const cacheKey = `/sw-video/${fileId}`;
  
  if (activeDownloads.has(cacheKey)) return;
  activeDownloads.add(cacheKey);

  fetch(googleDriveUrl)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(cacheKey, response);
      }
    })
    .catch((err) => {
      console.warn(`Download em segundo plano falhou para o arquivo ${fileId}:`, err);
    })
    .finally(() => {
      activeDownloads.delete(cacheKey);
    });
}

// Slice no Blob cacheado para simular o comportamento de Range (206 Partial Content)
async function serveRangeFromCachedResponse(response, rangeHeader) {
  try {
    const blob = await response.blob();
    const totalLength = blob.size;
    
    // Tratamento de cabeçalho Range (ex: bytes=0-1 ou bytes=2000-)
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalLength - 1;

    // Se o Range for inválido ou extrapolou o arquivo
    if (start >= totalLength || end >= totalLength) {
      return new Response('', {
        status: 416,
        statusText: 'Range Not Satisfiable',
        headers: {
          'Content-Range': `bytes */${totalLength}`
        }
      });
    }

    const slicedBlob = blob.slice(start, end + 1, blob.type);
    return new Response(slicedBlob, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': blob.type || 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${totalLength}`,
        'Content-Length': String(slicedBlob.size)
      }
    });
  } catch (err) {
    console.error('Erro ao fatiar resposta em cache do SW:', err);
    return new Response('Error parsing video range', { status: 500 });
  }
}
