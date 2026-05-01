import { useEffect, useState } from 'react';
import type { AutomationSettings, GenerationMode } from '@/lib/contracts';
import { getRuntimeState, updateSettings } from '@/lib/runtime';
import './App.css';

function App() {
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const state = await getRuntimeState();
    setSettings(state.settings);
  }

  async function save() {
    if (!settings) {
      return;
    }

    setSaving(true);

    try {
      const nextState = await updateSettings({
        ...settings,
        outputsPerPrompt: Math.max(1, settings.outputsPerPrompt),
        maxRetries: Math.max(1, settings.maxRetries),
        delayRange: {
          minSeconds: Math.max(0, settings.delayRange.minSeconds),
          maxSeconds: Math.max(
            settings.delayRange.minSeconds,
            settings.delayRange.maxSeconds,
          ),
        },
      });
      setSettings(nextState.settings);
      setNotice('Settings saved.');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <main className="options-app surface">Loading settings...</main>;
  }

  return (
    <main className="options-app">
      <section className="surface options-hero">
        <div className="options-hero-copy">
          <div className="options-hero-brand">
            <img src="/icon/source.svg" alt="Ex Grok logo" className="options-brand-mark" />
            <div>
              <p className="eyebrow">Settings</p>
              <h1>Default automation profile</h1>
            </div>
          </div>
          <p className="muted">
            These values seed the side panel when building a new batch queue.
          </p>
        </div>
        <span className="tag">Phase 1</span>
      </section>

      <section className="surface options-grid">
        <label className="field-stack">
          <span className="field-label">Default mode</span>
          <select
            value={settings.defaultMode}
            onChange={(event) =>
              setSettings({
                ...settings,
                defaultMode: event.target.value as GenerationMode,
              })
            }
          >
            <option value="text-to-video">Text to video</option>
            <option value="frame-to-video">Frame to video</option>
          </select>
        </label>

        <label className="field-stack">
          <span className="field-label">Aspect ratio</span>
          <select
            value={settings.aspectRatio}
            onChange={(event) =>
              setSettings({
                ...settings,
                aspectRatio: event.target.value as AutomationSettings['aspectRatio'],
              })
            }
          >
            <option value="16:9">16:9 Widescreen</option>
            <option value="9:16">9:16 Vertical</option>
            <option value="1:1">1:1 Square</option>
            <option value="3:2">3:2 Wide</option>
            <option value="2:3">2:3 Tall</option>
          </select>
        </label>

        <label className="field-stack">
          <span className="field-label">Video quality</span>
          <select
            value={settings.imageQuality}
            onChange={(event) =>
              setSettings({
                ...settings,
                imageQuality: event.target.value as AutomationSettings['imageQuality'],
              })
            }
          >
            <option value="480p">480p</option>
            <option value="720p">720p (SuperGrok)</option>
          </select>
        </label>

        <label className="field-stack">
          <span className="field-label">Video duration</span>
          <select
            value={settings.videoDuration}
            onChange={(event) =>
              setSettings({
                ...settings,
                videoDuration: event.target.value as AutomationSettings['videoDuration'],
              })
            }
          >
            <option value="6s">6 seconds</option>
            <option value="10s">10 seconds (SuperGrok)</option>
          </select>
        </label>

        <label className="field-stack">
          <span className="field-label">How images map to prompts</span>
          <select
            value={settings.imageProcessingMode}
            onChange={(event) =>
              setSettings({
                ...settings,
                imageProcessingMode:
                  event.target.value as AutomationSettings['imageProcessingMode'],
              })
            }
          >
            <option value="start-frame-only">Use the first image for every prompt</option>
            <option value="pair-each-image">Match prompt 1 to image 1, prompt 2 to image 2</option>
          </select>
          <span className="field-hint muted">Reuse one opening frame for the whole batch, or pair prompts and images one by one.</span>
        </label>

        <label className="field-stack">
          <span className="field-label">Outputs per prompt</span>
          <input
            min={1}
            type="number"
            value={settings.outputsPerPrompt}
            onChange={(event) =>
              setSettings({
                ...settings,
                outputsPerPrompt: Number(event.target.value),
              })
            }
          />
        </label>

        <label className="field-stack">
          <span className="field-label">Max retries</span>
          <input
            min={1}
            type="number"
            value={settings.maxRetries}
            onChange={(event) =>
              setSettings({
                ...settings,
                maxRetries: Number(event.target.value),
              })
            }
          />
        </label>

        <label className="field-stack">
          <span className="field-label">Delay min (seconds)</span>
          <input
            min={0}
            type="number"
            value={settings.delayRange.minSeconds}
            onChange={(event) =>
              setSettings({
                ...settings,
                delayRange: {
                  ...settings.delayRange,
                  minSeconds: Number(event.target.value),
                },
              })
            }
          />
        </label>

        <label className="field-stack">
          <span className="field-label">Delay max (seconds)</span>
          <input
            min={settings.delayRange.minSeconds}
            type="number"
            value={settings.delayRange.maxSeconds}
            onChange={(event) =>
              setSettings({
                ...settings,
                delayRange: {
                  ...settings.delayRange,
                  maxSeconds: Number(event.target.value),
                },
              })
            }
          />
        </label>

        <label className="field-stack options-span">
          <span className="field-label">Default output folder</span>
          <input
            value={settings.outputFolder}
            onChange={(event) =>
              setSettings({
                ...settings,
                outputFolder: event.target.value,
              })
            }
          />
          <span className="field-hint muted">Files are saved into Downloads/{settings.outputFolder || 'folder-name'}.</span>
        </label>

        <label className="toggle-row options-span">
          <input
            checked={settings.autoRename}
            type="checkbox"
            onChange={(event) =>
              setSettings({
                ...settings,
                autoRename: event.target.checked,
              })
            }
          />
          <div>
            <strong>Auto rename downloads</strong>
            <p className="muted">Keep generated filenames deterministic per queue job.</p>
          </div>
        </label>
      </section>

      <section className="button-row">
        <button disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving...' : 'Save settings'}
        </button>
        {notice ? <p className="muted notice-copy">{notice}</p> : null}
      </section>
    </main>
  );
}

export default App;