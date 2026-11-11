'use client';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@qarabic/ui/components/input-group';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type ComponentProps } from 'react';

/** Password field from the shadcn Input Group pattern: input + inline-end icon button. */
export function PasswordInput(props: Omit<ComponentProps<typeof InputGroupInput>, 'type'>) {
  const t = useTranslations('auth');
  const [visible, setVisible] = useState(false);
  return (
    <InputGroup>
      <InputGroupInput
        type={visible ? 'text' : 'password'}
        dir="ltr"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={visible ? t('hidePassword') : t('showPassword')}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
