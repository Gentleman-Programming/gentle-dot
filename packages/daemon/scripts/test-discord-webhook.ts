#!/usr/bin/env node
/**
 * Discord Webhook test script for Gentle Dot.
 * Usage: DISCORD_WEBHOOK_URL="..." node test-discord-webhook.ts
 */

import { createDiscordWebhookFromEnv, globalWebhookManager } from '../src/discord-webhook.ts';

async function main() {
  console.log('🔧 Gentle Dot Discord Webhook Test');
  console.log('==================================\n');

  const webhook = createDiscordWebhookFromEnv();
  if (!webhook) {
    console.error('❌ DISCORD_WEBHOOK_URL not set');
    console.log('\nSet it with:');
    console.log('  export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."');
    console.log('  # Optional:');
    console.log('  export DISCORD_WEBHOOK_USERNAME="Gentle Dot"');
    console.log('  export DISCORD_WEBHOOK_AVATAR="https://..."');
    console.log('  export DISCORD_WEBHOOK_ENABLED="true"');
    process.exit(1);
  }

  const config = webhook.getConfig();
  console.log('Config:', config);
  console.log('');

  // Test 1: Simple message
  console.log('Test 1: Simple message...');
  const result1 = await webhook.send('🔧 Test message from Gentle Dot!');
  console.log(result1.success ? '✅ Success' : '❌ Failed:', result1.error || `Message ID: ${result1.messageId}`);
  console.log('');

  // Test 2: Embed notification
  console.log('Test 2: Embed notification (info)...');
  const result2 = await webhook.notify({
    title: 'Test Notification',
    description: 'This is a test notification from Gentle Dot',
    level: 'info',
    fields: [
      { name: 'Environment', value: 'Development', inline: true },
      { name: 'Version', value: '0.1.0', inline: true },
    ],
    url: 'https://gentlemanprogramming.com',
  });
  console.log(result2.success ? '✅ Success' : '❌ Failed:', result2.error || `Message ID: ${result2.messageId}`);
  console.log('');

  // Test 3: Status update
  console.log('Test 3: Service status (online)...');
  const result3 = await webhook.sendStatus({
    service: 'Gentle Dot Daemon',
    status: 'online',
    message: 'Daemon started successfully',
    details: {
      Uptime: '2h 34m',
      Memory: '128 MB',
      Connections: '3',
    },
  });
  console.log(result3.success ? '✅ Success' : '❌ Failed:', result3.error || `Message ID: ${result3.messageId}`);
  console.log('');

  // Test 4: Error notification
  console.log('Test 4: Error notification...');
  const result4 = await webhook.notify({
    title: 'Test Error',
    description: 'This is a test error notification',
    level: 'error',
    fields: [
      { name: 'Error Code', value: 'TEST_001', inline: true },
      { name: 'Severity', value: 'High', inline: true },
    ],
  });
  console.log(result4.success ? '✅ Success' : '❌ Failed:', result4.error || `Message ID: ${result4.messageId}`);
  console.log('');

  // Test 5: Multi-webhook manager (if multiple URLs)
  const allUrls = [
    process.env.DISCORD_WEBHOOK_URL,
    process.env.DISCORD_WEBHOOK_URL_2,
    process.env.DISCORD_WEBHOOK_URL_3,
  ].filter(Boolean);

  if (allUrls.length > 1) {
    console.log('Test 5: Multi-webhook manager...');
    for (const [i, url] of allUrls.entries()) {
      globalWebhookManager.add(`webhook-${i + 1}`, webhook);
    }
    const results = await globalWebhookManager.testAll();
    for (const [name, result] of results) {
      console.log(`  ${name}: ${result.success ? '✅' : '❌'} ${result.error || ''}`);
    }
  }

  console.log('\n✅ All tests completed!');
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});