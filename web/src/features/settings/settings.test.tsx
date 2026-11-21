import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers';
import { SettingsPage } from './settings';
import i18n from '../../i18n';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('saves the SMS group using the documented conditional settings endpoint', async () => {
  await i18n.changeLanguage('en');
  let settings = { inboundPlatform: 'telegram', smsForward: false, smsRatePerMin: 10, heartbeatSec: 30, offlineAfterSec: 90, botLocale: 'en', defaultDeviceId: null, inboundRingTimeoutSec: 20, outboundUserAnswerTimeoutSec: 15, outboundCalleeAnswerTimeoutSec: 30, outboundCallbackRingTimeoutSec: 30, alertPushIntervalSec: 1800, earlyMediaThresholdDbfs: -50 };
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/settings/conditional' && options?.method === 'PUT') settings = { ...settings, smsForward: true };
    return new Response(JSON.stringify({ data: url.startsWith('/api/devices?') ? [] : settings, nextCursor: null }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AppProviders><SettingsPage/></AppProviders>);
  const check = await screen.findByLabelText('Forward messages');
  fireEvent.click(check);
  const save = within(check.closest('form')!).getByRole('button', { name: 'Save' });
  fireEvent.click(save);
  await waitFor(() => { expect(check).toBeEnabled(); expect(save).toBeDisabled(); });
  const writes = fetcher.mock.calls.filter(call => call[1]?.method === 'PUT');
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe('/api/settings/conditional');
  expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ changes: { smsForward: true }, expected: { smsForward: false } });
});
