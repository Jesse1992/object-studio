import React, { useState, useRef, useCallback } from 'react';
import { Upload, Download, RefreshCw, Save, Edit3, Check, X, Key } from 'lucide-react';
import { removeBackground } from '@imgly/background-removal';
import { motion, AnimatePresence } from 'motion/react';
import html2canvas from 'html2canvas';

// ── Trim transparent padding from a PNG blob ────────────────────
async function trimTransparentPixels(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      const { data } = ctx.getImageData(0, 0, w, h);
      let top = h, bottom = 0, left = w, right = 0;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = data[(y * w + x) * 4 + 3];
          if (a > 10) {
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }

      if (right < left || bottom < top) {
        resolve(canvas.toDataURL('image/png'));
        return;
      }

      // Add a small padding so shadow isn't clipped
      const pad = Math.max(8, Math.round(Math.max(w, h) * 0.02));
      const cx = Math.max(0, left - pad);
      const cy = Math.max(0, top - pad);
      const cw = Math.min(w, right - cx + pad * 2);
      const ch = Math.min(h, bottom - cy + pad * 2);

      const out = document.createElement('canvas');
      out.width = cw;
      out.height = ch;
      out.getContext('2d')!.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
      resolve(out.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ── AI Provider Config ──────────────────────────────────────────
interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  placeholder: string;
  keyUrl: string;
  note?: string;
}

const PROVIDERS: Provider[] = [
  {
    id: 'moonshot',
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k-vision-preview',
    placeholder: 'sk-...',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    placeholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    placeholder: 'AIza...',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    note: 'Gemini via OpenAI-compatible endpoint',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
    placeholder: '...',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
    placeholder: 'sk-...',
    keyUrl: 'https://bailian.console.aliyun.com/',
    note: '需开通 DashScope 百炼',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    placeholder: 'sk-...',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '文字描述（暂不支持图片识别）',
  },
];

const PROVIDER_STORAGE = 'ai_provider';
const ENV_KEY = process.env.KIMI_API_KEY ?? '';

function getProviderKey(providerId: string): string {
  const stored = localStorage.getItem(`ai_key_${providerId}`);
  if (stored) return stored;
  if (providerId === 'moonshot') return ENV_KEY;
  return '';
}

function saveProviderKey(providerId: string, key: string) {
  localStorage.setItem(`ai_key_${providerId}`, key);
  localStorage.setItem(PROVIDER_STORAGE, providerId);
}

function getCurrentProvider(): Provider {
  const id = localStorage.getItem(PROVIDER_STORAGE) || 'moonshot';
  return PROVIDERS.find(p => p.id === id) || PROVIDERS[0];
}

const PROMPT = 'Identify the main object in this image. Give it a concise, poetic product name in English like a vintage catalog label (3–7 words total). If it reads better on two lines, split into line1 and line2; otherwise just line1. Reply with JSON only, no extra text. Schema: { "line1": string, "line2"?: string }';

async function describeImage(
  base64Data: string,
  mimeType: string,
  provider: Provider,
  apiKey: string,
): Promise<{ line1: string; line2?: string }> {
  if (!apiKey) throw new Error(`请先设置 ${provider.name} API Key`);

  const messages =
    provider.id === 'deepseek'
      ? [{ role: 'user', content: PROMPT }]
      : [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
              { type: 'text', text: PROMPT },
            ],
          },
        ];

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: provider.model, messages, temperature: 0.7 }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${provider.name} API error: ${err}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '{}';
  const json = content.replace(/```json?/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(json);
  } catch {
    return { line1: content.trim().slice(0, 60) };
  }
}

type Status = 'idle' | 'processing' | 'success' | 'error';

const SAMPLES = [
  {
    src: '/samples/sample1.png',
    caption: 'Bow tie belt lanyard',
    sub: 'employee badge',
  },
  {
    src: '/samples/sample2.png',
    caption: 'Hand-carved simulated flip',
    sub: 'phone pendant',
  },
  {
    src: '/samples/sample3.png',
    caption: 'Lace bowknot texture',
    sub: 'underarm bag',
  },
  {
    src: '/samples/sample4.png',
    caption: 'Spring season diamond pattern',
    sub: 'V-neck sweater',
  },
];

function CardLayout({
  children,
  innerRef,
  className = '',
}: {
  children: React.ReactNode;
  innerRef?: React.RefObject<HTMLDivElement>;
  className?: string;
}) {
  return (
    <div
      ref={innerRef}
      className={`catalog-card relative overflow-hidden ${className}`}
      style={{ backgroundColor: '#EFE2D6' }}
    >
      <div className="noise-overlay" />
      <div className="vignette-overlay" />
      {children}
    </div>
  );
}

function CatalogCard({
  imageSrc,
  caption,
  sub,
  innerRef,
}: {
  imageSrc: string;
  caption: string;
  sub?: string;
  innerRef?: React.RefObject<HTMLDivElement>;
}) {
  return (
    <CardLayout innerRef={innerRef}>
      {/* Image: top 72%, with top breathing room */}
      <div
        className="absolute inset-x-0 top-0 flex items-center justify-center z-10 px-6"
        style={{ height: '82%', paddingTop: '6%' }}
      >
        <img
          src={imageSrc}
          alt={caption}
          className="max-w-full max-h-full object-contain"
          style={{ filter: 'drop-shadow(0 8px 24px rgba(80,60,30,0.13))' }}
          crossOrigin="anonymous"
        />
      </div>
      {/* Text: pinned to bottom */}
      <div
        className="absolute inset-x-0 bottom-0 z-10 px-6 flex flex-col items-center"
        style={{ paddingBottom: '11%' }}
      >
        <p className="font-typewriter text-[13px] tracking-[0.08em] text-stone-700 leading-snug">
          {caption}
        </p>
        {sub && (
          <p className="font-typewriter text-[13px] tracking-[0.08em] text-stone-700 leading-snug mt-0.5">
            {sub}
          </p>
        )}
      </div>
    </CardLayout>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [progressText, setProgressText] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [processedImage, setProcessedImage] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [sub, setSub] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [editingCaption, setEditingCaption] = useState(false);
  const [editCaption, setEditCaption] = useState('');
  const [editSub, setEditSub] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [activeProvider, setActiveProvider] = useState<Provider>(() => getCurrentProvider());
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(PROVIDERS.map(p => [p.id, getProviderKey(p.id)]))
  );
  const hasKey = !!getProviderKey(activeProvider.id);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null!);

  const readFileAsDataURL = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const processImage = async (file: File) => {
    try {
      setStatus('processing');
      setErrorMsg('');
      setProgressPct(0);

      setProgressText('Removing background...');
      const blob = await removeBackground(file, {
        progress: (_key: string, current: number, total: number) => {
          const pct = Math.round((current / total) * 70);
          setProgressPct(pct);
          setProgressText(`Removing background  ${pct}%`);
        },
      });
      const processedUrl = await trimTransparentPixels(blob);
      setProcessedImage(processedUrl);
      setProgressPct(75);

      setProgressText('Analyzing object...');
      const dataUrl = await readFileAsDataURL(file);
      const base64Data = dataUrl.split(',')[1];
      const mimeType = file.type;

      const provider = getCurrentProvider();
      const apiKey = getProviderKey(provider.id);
      const result = await describeImage(base64Data, mimeType, provider, apiKey);
      setProgressPct(95);
      const cap = result.line1 || 'Unknown Object';
      const subLine = result.line2 || '';
      setCaption(cap);
      setSub(subLine);
      setEditCaption(cap);
      setEditSub(subLine);
      setProgressPct(100);
      setStatus('success');
    } catch (err: unknown) {
      console.error(err);
      setErrorMsg((err as Error).message || 'An error occurred during processing.');
      setStatus('error');
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processImage(file);
  };

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    await processImage(file);
  }, []);

  const reset = () => {
    setStatus('idle');
    setProcessedImage(null);
    setCaption('');
    setSub('');
    setErrorMsg('');
    setEditingCaption(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const confirmEdit = () => {
    setCaption(editCaption);
    setSub(editSub);
    setEditingCaption(false);
  };

  const downloadResult = async () => {
    if (!processedImage) return;
    try {
      const SCALE = 3;
      const cardEl = resultRef.current;
      const cardW = cardEl ? cardEl.offsetWidth : 320;
      const cardH = cardEl ? cardEl.offsetHeight : Math.round(cardW * 4 / 3);
      const W = cardW * SCALE;
      const H = cardH * SCALE;

      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d')!;

      // ── Paper background: warm kraft #EFE2D6 ──
      ctx.fillStyle = '#EFE2D6';
      ctx.fillRect(0, 0, W, H);

      // Prominent fiber grain + speckle (matching reference cardstock texture)
      const imageData = ctx.getImageData(0, 0, W, H);
      const data = imageData.data;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const idx = (y * W + x) * 4;
          const speckle = (Math.random() - 0.5) * 28;
          const fiber = Math.sin(y * 0.10) * 5 + Math.sin(y * 0.27 + x * 0.003) * 3;
          const delta = speckle + fiber;
          data[idx]     = Math.min(255, Math.max(0, data[idx]     + delta));
          data[idx + 1] = Math.min(255, Math.max(0, data[idx + 1] + delta * 0.97));
          data[idx + 2] = Math.min(255, Math.max(0, data[idx + 2] + delta * 0.88));
        }
      }
      ctx.putImageData(imageData, 0, 0);

      // Load product image
      const img = new Image();
      img.src = processedImage;
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = rej;
      });

      // Image area: top 82% of card, padded 6% top + px-6 sides
      const padTop = H * 0.06;
      const padSide = 24 * SCALE;
      const areaH = H * 0.82 - padTop;
      const areaW = W - padSide * 2;
      const scaleImg = Math.min(areaW / img.naturalWidth, areaH / img.naturalHeight);
      const drawW = img.naturalWidth * scaleImg;
      const drawH = img.naturalHeight * scaleImg;
      const drawX = padSide + (areaW - drawW) / 2;
      const drawY = padTop + (areaH - drawH) / 2;

      // Drop shadow
      ctx.save();
      ctx.shadowColor = 'rgba(80,60,30,0.18)';
      ctx.shadowBlur = 28 * SCALE;
      ctx.shadowOffsetY = 10 * SCALE;
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
      ctx.restore();

      // Text
      const fontSize = 13 * SCALE;
      ctx.font = `${fontSize}px "Courier Prime", "Courier New", monospace`;
      ctx.fillStyle = '#57534e';
      ctx.textAlign = 'center';
      ctx.letterSpacing = `${0.08 * fontSize}px`;
      const lineH = fontSize * 1.4;
      const lines = [caption, sub].filter(Boolean);
      const textTotalH = lines.length * lineH;
      const bottomPad = H * 0.11;
      const textBaseY = H - bottomPad - textTotalH + lineH * 0.8;
      lines.forEach((line, i) => {
        ctx.fillText(line, W / 2, textBaseY + i * lineH);
      });

      // Subtle vignette
      const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.8);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(80,60,30,0.07)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `${caption.replace(/\s+/g, '_').toLowerCase()}_catalog.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.error('Download failed', err);
    }
  };

  const downloadCutout = () => {
    if (!processedImage) return;
    const a = document.createElement('a');
    a.href = processedImage;
    a.download = `${caption.replace(/\s+/g, '_').toLowerCase()}_cutout.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="min-h-screen app-bg text-stone-900 selection:bg-amber-100">
      {/* Header */}
      <header className="w-full border-b border-stone-200/70 bg-[#f7f3ec]/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="font-typewriter text-sm tracking-widest text-stone-500 uppercase">
            Catalog
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowKeyModal(true)}
              className={`inline-flex items-center gap-1.5 font-typewriter text-xs tracking-wider transition-colors uppercase ${hasKey ? 'text-stone-400 hover:text-stone-700' : 'text-amber-500 hover:text-amber-700'}`}
            >
              <Key className="w-3 h-3" />
              {hasKey ? `${activeProvider.name} ✓` : 'Set API Key'}
            </button>
            <button
              onClick={() => { reset(); fileInputRef.current?.click(); }}
              className="font-typewriter text-xs tracking-widest text-stone-400 hover:text-stone-700 transition-colors uppercase hidden sm:block"
            >
              Upload ↑
            </button>
          </div>
        </div>
      </header>

      {/* API Key Modal */}
      <AnimatePresence>
        {showKeyModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center px-4"
            style={{ background: 'rgba(30,20,10,0.4)', backdropFilter: 'blur(6px)' }}
            onClick={(e) => { if (e.target === e.currentTarget) setShowKeyModal(false); }}
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.97 }}
              className="w-full max-w-lg bg-[#f7f3ec] rounded-2xl shadow-2xl border border-stone-200/60 overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-7 pt-7 pb-5">
                <div>
                  <h2 className="font-serif text-xl text-stone-800">AI Provider</h2>
                  <p className="font-typewriter text-xs text-stone-400 mt-0.5 tracking-wide">
                    选择模型并填入对应 API Key
                  </p>
                </div>
                <button onClick={() => setShowKeyModal(false)} className="text-stone-300 hover:text-stone-500 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Provider tabs */}
              <div className="px-7 pb-4">
                <div className="flex flex-wrap gap-2">
                  {PROVIDERS.map(p => {
                    const hasK = !!keyInputs[p.id];
                    const isActive = activeProvider.id === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => setActiveProvider(p)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-typewriter tracking-wide border transition-all duration-150 ${
                          isActive
                            ? 'bg-stone-800 text-white border-stone-800'
                            : 'bg-white/60 text-stone-500 border-stone-200 hover:border-stone-400 hover:text-stone-700'
                        }`}
                      >
                        {hasK && <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-green-400' : 'bg-green-500'}`} />}
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Key input for selected provider */}
              <div className="px-7 pb-7">
                <div className="bg-white/50 border border-stone-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="font-typewriter text-xs text-stone-500 tracking-wide">
                      {activeProvider.name} · <span className="text-stone-400">{activeProvider.model}</span>
                    </p>
                    <a
                      href={activeProvider.keyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-typewriter text-xs text-stone-400 hover:text-stone-600 underline underline-offset-2 transition-colors"
                    >
                      获取 Key →
                    </a>
                  </div>
                  {activeProvider.note && (
                    <p className="font-typewriter text-[10px] text-amber-500 mb-2 tracking-wide">{activeProvider.note}</p>
                  )}
                  <input
                    key={activeProvider.id}
                    type="password"
                    value={keyInputs[activeProvider.id] || ''}
                    onChange={(e) => setKeyInputs(prev => ({ ...prev, [activeProvider.id]: e.target.value }))}
                    placeholder={activeProvider.placeholder}
                    className="w-full bg-transparent font-typewriter text-sm text-stone-700 focus:outline-none tracking-wide placeholder:text-stone-300"
                    autoFocus
                  />
                </div>

                <div className="flex gap-3 mt-4">
                  <button
                    onClick={() => {
                      const key = keyInputs[activeProvider.id] || '';
                      saveProviderKey(activeProvider.id, key);
                      localStorage.setItem(PROVIDER_STORAGE, activeProvider.id);
                      setShowKeyModal(false);
                    }}
                    className="flex-1 py-2.5 bg-stone-800 text-white text-sm rounded-full hover:bg-stone-700 transition-colors font-medium"
                  >
                    Save &amp; Use {activeProvider.name}
                  </button>
                  {keyInputs[activeProvider.id] && (
                    <button
                      onClick={() => {
                        localStorage.removeItem(`ai_key_${activeProvider.id}`);
                        setKeyInputs(prev => ({ ...prev, [activeProvider.id]: '' }));
                      }}
                      className="px-4 py-2.5 border border-stone-200 text-stone-400 text-sm rounded-full hover:bg-stone-100 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="max-w-6xl mx-auto px-4 sm:px-6">
        <AnimatePresence mode="wait">
          {/* ── IDLE: Hero + Gallery ── */}
          {status === 'idle' && (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.5 }}
            >
              {/* Hero */}
              <section className="pt-20 pb-14 text-center">
                <motion.p
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="font-typewriter text-xs tracking-[0.25em] text-stone-400 uppercase mb-6"
                >
                  Vintage Catalog Generator
                </motion.p>
                <motion.h1
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="font-serif text-4xl sm:text-5xl md:text-6xl text-stone-800 tracking-tight leading-tight mb-6"
                >
                  Turn any object into<br />
                  <em className="italic text-stone-500">a catalog moment</em>
                </motion.h1>
                <motion.p
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="text-stone-400 text-base max-w-md mx-auto mb-10 leading-relaxed"
                >
                  Upload a photo — we'll extract the subject, name it, and compose it into a timeless vintage-style card.
                </motion.p>
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 }}
                >
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2.5 px-8 py-3.5 bg-stone-800 text-white text-sm font-medium rounded-full hover:bg-stone-700 transition-all duration-200 shadow-lg shadow-stone-800/15 hover:shadow-stone-800/25 hover:-translate-y-0.5"
                  >
                    <Upload className="w-4 h-4" />
                    Choose an image
                  </button>
                </motion.div>
              </section>

              {/* Sample Gallery */}
              <motion.section
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.6 }}
                className="pb-20"
              >
                <p className="font-typewriter text-[11px] tracking-[0.3em] text-stone-400 uppercase text-center mb-8">
                  Sample outputs
                </p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-5">
                  {SAMPLES.map((s, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.55 + i * 0.08 }}
                      className="aspect-[3/4] shadow-md shadow-stone-300/60 hover:shadow-xl hover:shadow-stone-300/80 hover:-translate-y-1 transition-all duration-300 cursor-default rounded-sm overflow-hidden"
                    >
                      <img
                        src={s.src}
                        alt={s.caption}
                        className="w-full h-full object-cover"
                      />
                    </motion.div>
                  ))}
                </div>
              </motion.section>

              {/* Invisible full-page drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className="fixed inset-0 z-0 pointer-events-none"
              />

              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelect}
                accept="image/*"
                className="hidden"
              />
            </motion.div>
          )}

          {/* ── PROCESSING ── */}
          {status === 'processing' && (
            <motion.div
              key="processing"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.02 }}
              className="flex flex-col items-center justify-center min-h-[70vh]"
            >
              <div className="text-center">
                {/* Animated parchment card shimmer */}
                <div className="w-48 h-64 mx-auto mb-10 rounded-md overflow-hidden relative shadow-lg"
                  style={{ backgroundColor: '#EFE2D6' }}>
                  <div className="noise-overlay" />
                  <div className="absolute inset-0 animate-shimmer"
                    style={{
                      background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.4) 50%, transparent 100%)',
                      backgroundSize: '200% 100%',
                    }} />
                  <div className="absolute bottom-8 left-0 right-0 flex flex-col items-center gap-1.5 px-4">
                    <div className="h-1.5 bg-stone-200/80 rounded-full w-3/4 animate-pulse" />
                    <div className="h-1.5 bg-stone-200/60 rounded-full w-1/2 animate-pulse" style={{ animationDelay: '0.2s' }} />
                  </div>
                </div>

                <h3 className="font-serif text-2xl text-stone-800 mb-3">Crafting your card...</h3>
                <p className="font-typewriter text-sm text-stone-400 tracking-wide mb-8">{progressText}</p>

                {/* Progress bar */}
                <div className="w-64 mx-auto h-0.5 bg-stone-200 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-stone-700 rounded-full"
                    animate={{ width: `${progressPct}%` }}
                    transition={{ duration: 0.4, ease: 'easeOut' }}
                  />
                </div>
                <p className="font-typewriter text-xs text-stone-400 mt-3">{progressPct}%</p>
              </div>
            </motion.div>
          )}

          {/* ── ERROR ── */}
          {status === 'error' && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center min-h-[70vh] text-center max-w-md mx-auto"
            >
              <div className="w-16 h-16 bg-red-50 border border-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <X className="w-7 h-7 text-red-400" />
              </div>
              <h3 className="font-serif text-2xl text-stone-800 mb-3">Something went wrong</h3>
              <p className="font-typewriter text-sm text-stone-400 mb-8 leading-relaxed">{errorMsg}</p>
              <button
                onClick={reset}
                className="px-8 py-3 bg-stone-800 text-white text-sm rounded-full hover:bg-stone-700 transition-colors"
              >
                Try Again
              </button>
            </motion.div>
          )}

          {/* ── SUCCESS ── */}
          {status === 'success' && (
            <motion.div
              key="success"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="flex flex-col items-center py-16"
            >
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="font-typewriter text-[11px] tracking-[0.3em] text-stone-400 uppercase mb-10"
              >
                Your catalog card is ready
              </motion.p>

              {/* Result Card */}
              <motion.div
                initial={{ opacity: 0, y: 30, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ delay: 0.1, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="w-full max-w-xs sm:max-w-sm"
              >
                {/* Caption Edit Toggle */}
                <div className="flex justify-end mb-3">
                  {!editingCaption ? (
                    <button
                      onClick={() => { setEditCaption(caption); setEditSub(sub); setEditingCaption(true); }}
                      className="inline-flex items-center gap-1.5 font-typewriter text-xs text-stone-400 hover:text-stone-600 transition-colors"
                    >
                      <Edit3 className="w-3 h-3" />
                      Edit text
                    </button>
                  ) : (
                    <div className="flex gap-3">
                      <button
                        onClick={() => setEditingCaption(false)}
                        className="inline-flex items-center gap-1 font-typewriter text-xs text-stone-400 hover:text-stone-600 transition-colors"
                      >
                        <X className="w-3 h-3" />
                        Cancel
                      </button>
                      <button
                        onClick={confirmEdit}
                        className="inline-flex items-center gap-1 font-typewriter text-xs text-stone-700 hover:text-stone-900 transition-colors"
                      >
                        <Check className="w-3 h-3" />
                        Apply
                      </button>
                    </div>
                  )}
                </div>

                {/* The Card */}
                {processedImage && (
                  <CardLayout innerRef={resultRef} className="shadow-2xl shadow-stone-400/30">
                    {/* Image: top 72%, with top breathing room */}
                    <div
                      className="absolute inset-x-0 top-0 flex items-center justify-center z-10 px-6"
                      style={{ height: '82%', paddingTop: '6%' }}
                    >
                      <img
                        src={processedImage}
                        alt={caption}
                        className="max-w-full max-h-full object-contain"
                        style={{ filter: 'drop-shadow(0 10px 28px rgba(80,60,30,0.15))' }}
                        crossOrigin="anonymous"
                      />
                    </div>
                    {/* Text: pinned to bottom */}
                    <div
                      className="absolute inset-x-0 bottom-0 z-10 px-6 flex flex-col items-center"
                      style={{ paddingBottom: '11%' }}
                    >
                      <p className="font-typewriter text-[13px] tracking-[0.08em] text-stone-700 leading-snug">
                        {caption}
                      </p>
                      {sub && (
                        <p className="font-typewriter text-[13px] tracking-[0.08em] text-stone-700 leading-snug mt-0.5">
                          {sub}
                        </p>
                      )}
                    </div>
                  </CardLayout>
                )}

                {/* Inline edit fields */}
                <AnimatePresence>
                  {editingCaption && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-4 space-y-2">
                        <input
                          type="text"
                          value={editCaption}
                          onChange={(e) => setEditCaption(e.target.value)}
                          placeholder="Line 1"
                          className="w-full bg-white/60 border border-stone-200 rounded-lg px-3 py-2 font-typewriter text-sm text-stone-700 focus:outline-none focus:border-stone-400 tracking-wide"
                        />
                        <input
                          type="text"
                          value={editSub}
                          onChange={(e) => setEditSub(e.target.value)}
                          placeholder="Line 2 (optional)"
                          className="w-full bg-white/60 border border-stone-200 rounded-lg px-3 py-2 font-typewriter text-sm text-stone-700 focus:outline-none focus:border-stone-400 tracking-wide"
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>

              {/* Actions */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                className="flex flex-wrap items-center justify-center gap-3 mt-10"
              >
                <button
                  onClick={reset}
                  className="inline-flex items-center gap-2 px-5 py-2.5 border border-stone-400 text-stone-500 text-sm rounded-full hover:bg-stone-100 hover:text-stone-700 transition-all duration-200"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  New photo
                </button>
                <button
                  onClick={downloadResult}
                  className="inline-flex items-center gap-2 px-6 py-2.5 bg-stone-800 text-white text-sm rounded-full hover:bg-stone-700 transition-all duration-200 shadow-lg shadow-stone-800/20"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save card
                </button>
              </motion.div>

              <p className="font-typewriter text-xs text-stone-300 mt-6 tracking-wide">
                3× resolution export
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      {status === 'idle' && (
        <footer className="border-t border-stone-200/60 py-8 text-center">
          <p className="font-typewriter text-[10px] tracking-[0.3em] text-stone-300 uppercase">
            Object Studio · Powered by AI
          </p>
        </footer>
      )}
    </div>
  );
}
