import { Check, Palette } from 'lucide-react';
import { THEMES, type ThemeId } from '../lib/themes';

export function ThemePicker({ theme, onChange }: { theme: ThemeId; onChange: (theme: ThemeId) => void }) {
  return (
    <section className="mt-5 border-t border-line pt-5" aria-labelledby="theme-title">
      <h3 id="theme-title" className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Palette className="h-4 w-4" aria-hidden="true" /> Personalización
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">11 paletas conocidas. El tema se aplica al momento y se recuerda para tu cuenta en este navegador.</p>
      <fieldset className="mt-3 grid grid-cols-2 gap-2.5">
        <legend className="sr-only">Elige el tema del chat</legend>
        {THEMES.map((option) => (
          <label key={option.id} data-theme={option.id} className="min-w-0 cursor-pointer">
            <input type="radio" name="chat-theme" value={option.id} checked={theme === option.id}
              onChange={() => onChange(option.id)} className="peer sr-only" />
            <span className="block overflow-hidden rounded-2xl border border-line bg-surface p-2.5 text-ink peer-checked:border-accent peer-checked:ring-2 peer-checked:ring-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-accent">
              <span aria-hidden="true" className="flex h-14 flex-col justify-center gap-1.5 rounded-xl bg-surface-muted px-3">
                <span className="h-2.5 w-3/5 rounded-full bg-surface" />
                <span className="h-2.5 w-1/2 self-end rounded-full bg-accent-soft" />
              </span>
              <span className="mt-2 flex items-center justify-between gap-1">
                <span className="text-xs font-semibold">{option.name}</span>
                {theme === option.id && <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />}
              </span>
              <span className="block text-[11px] text-muted">{option.mode}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}
