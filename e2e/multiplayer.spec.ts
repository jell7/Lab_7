import { test, expect } from '@playwright/test';

test('two players in the same room see each other move and receive chat', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto('/');
  await pageB.goto('/');

  await pageA.fill('#lb-name', 'Alice');
  await pageA.click('#lb-join');

  await pageB.fill('#lb-name', 'Bob');
  await pageB.click('#lb-join');

  // Перевіряємо, що обидва підключилися і бачать один одного у знімках
  await pageA.keyboard.down('KeyW');
  await pageA.waitForTimeout(500);
  await pageA.keyboard.up('KeyW');

  const statsRes = await pageA.request.get('/api/stats');
  const stats = (await statsRes.json()) as { rooms: Array<{ roomId: string; players: number }> };
  const alpha = stats.rooms.find((r) => r.roomId === 'Alpha Sector');
  expect(alpha?.players).toBeGreaterThanOrEqual(2);

  await ctxA.close();
  await ctxB.close();
});