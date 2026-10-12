import { useId } from 'react';
import { cn } from '@/lib/cn';

/** On/off toggle (active flags). */
export function Switch({ checked, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative h-7 w-12 shrink-0 rounded-full border border-white/25 transition-colors disabled:opacity-50', checked ? 'bg-emerald-400/70' : 'bg-white/10')}>
      <span className={cn('absolute top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow transition-[left]', checked ? 'left-[22px]' : 'left-[2px]')} />
    </button>
  );
}

/** Labelled input (or textarea) with an optional hint under it. */
export function Field({ label, hint, multiline, className, ...props }) {
  const id = useId();
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-[12px] dimmer">{label}</span>
      <Tag className={cn('field', multiline && 'resize-none !rounded-[18px]', hint && '!border-amber-300')} autoComplete="off"
        aria-invalid={hint ? true : undefined} aria-describedby={hint ? id : undefined} {...props} />
      {hint && <span id={id} className="text-[12px] text-amber-200">{hint}</span>}
    </label>
  );
}
