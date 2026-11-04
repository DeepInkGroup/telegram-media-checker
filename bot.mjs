import { writeFile, readFile, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import MediaInfo from 'mediainfo.js';
import { quota, consume, dailyLimits, setLimit, resetUsage } from './quota.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN before starting the bot.');
const adminId = 1061254944;
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : dirname(fileURLToPath(import.meta.url));
const dataPath = join(dataDir, 'users.json');
const settingsPath = join(dataDir, 'settings.json');
let botEnabled = true;
let requiredChannels = [];
try {
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  if (!setLimit('free', settings.free) || !setLimit('pro', settings.pro)) throw new Error('Invalid daily limits in settings.json');
  if (settings.botEnabled !== undefined && typeof settings.botEnabled !== 'boolean') throw new Error('Invalid bot status in settings.json');
  botEnabled = settings.botEnabled ?? true;
  if (settings.requiredChannels !== undefined && !Array.isArray(settings.requiredChannels)) throw new Error('Invalid required channels in settings.json');
  requiredChannels = settings.requiredChannels ?? [];
} catch (error) { if (error.code !== 'ENOENT') throw error; }
let users;
try { users = JSON.parse(await readFile(dataPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; users = {}; }
async function saveUsers() {
  const temp = join(dataDir, 'users.json.tmp');
  await writeFile(temp, JSON.stringify(users, null, 2));
  await rename(temp, dataPath);
}
async function saveSettings(settings) {
  const temp = join(dataDir, 'settings.json.tmp');
  await writeFile(temp, JSON.stringify(settings, null, 2));
  await rename(temp, settingsPath);
}
function settingsWith(changes = {}) { return { ...dailyLimits, botEnabled, requiredChannels, ...changes }; }
const api = `https://api.telegram.org/bot${token}/`;
async function call(method, params = {}) {
  const response = await fetch(api + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const result = await response.json();
  if (!result.ok) throw new Error(`${method}: ${result.description}`);
  return result.result;
}
const size = n => n == null ? 'Unknown' : `${(n / 1024 / 1024).toFixed(2)} MB (${n.toLocaleString()} bytes)`;
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const row = (icon, label, value) => `${icon} <b>${label}</b>  ${escapeHtml(value)}`;
const duration = n => { const s = Math.round(Number(n)); return Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : null; };
async function adminCommand(message, command, args) {
  const chat_id = message.chat.id;
  if (message.from?.id !== adminId || message.chat.type !== 'private') {
    await call('sendMessage', {chat_id, text:'This command is available to the administrator in a private chat.'});
    return;
  }
  const list = Object.values(users);
  let text;
  if (command === 'admin') {
    const day = Date.now() - 86400000;
    text = ['🛠 <b>Admin dashboard</b>', '', row('🤖', 'Bot replies', botEnabled ? 'On' : 'Off'), row('📣', 'Required channels', requiredChannels.length), row('👥', 'Users', list.length), row('🟢', 'Active in 24 hours', list.filter(u => Date.parse(u.lastSeen) >= day).length), row('🚫', 'Blocked', list.filter(u => u.blocked).length), row('🖼', 'Media received', list.reduce((n, u) => n + (u.mediaCount || 0), 0)), row('📊', 'Daily limits', `Free: ${dailyLimits.free} · Pro: ${dailyLimits.pro}`), '', '<b>Commands</b>', '/bot on|off — enable or pause user replies', '/channels — list required channels', '/channeladd @username [invite link] — require a channel', '/channelremove ID — remove a channel requirement', '/users — recent users', '/user ID — user details', '/plan ID free|pro — change plan', '/limit free|pro NUMBER — change daily limit', '/reset ID — reset daily usage', '/reset all — reset everyone’s daily usage', '/ban ID — block bot access', '/unban ID — restore access', '/send ID message — message one user', '/broadcast message — message all eligible users'].join('\n');
  } else if (command === 'users') {
    const recent = list.sort ( (a,b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 20);
    text = ['👥 <b>Recent users</b> (up to 20)', '', ...recent.map(u => `${u.blocked ? '🚫' : '👤'} <code>${u.id}</code> · ${escapeHtml(u.name || 'Unknown')}${u.username ? ` (@${escapeHtml(u.username)})` : ''}`), ...(recent.length ? [] : ['No users yet.'])].join('\n');
  } else if (command === 'channels') {
    text = ['📣 <b>Required channels</b>', '', ...(requiredChannels.length ? requiredChannels.map(c => `• ${escapeHtml(c.title)} — <code>${escapeHtml(c.id)}</code>`) : ['No channels required.']), '', 'Add the bot as an administrator in each channel so it can check membership.'].join('\n');
  } else if (command === 'channeladd') {
    const identifier = args[0];
    const validId = /^@[a-zA-Z0-9_]{5,32}$/.test(identifier || '') || /^-100\d+$/.test(identifier || '');
    const link = args[1];
    const validLink = !link || /^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]+|joinchat\/[A-Za-z0-9_-]+|[A-Za-z0-9_]{5,32})\/?$/.test(link);
    if (!validId || !validLink || args.length > 2) text = 'Usage: /channeladd @username [https://t.me/invite-link] or /channeladd -100CHANNELID https://t.me/invite-link';
    else if (requiredChannels.length >= 10) text = 'At most 10 channels can be required.';
    else {
      try {
        const chat = await call('getChat', {chat_id: identifier});
        const me = await call('getMe');
        const member = await call('getChatMember', {chat_id: chat.id, user_id: me.id});
        if (chat.type !== 'channel') text = 'Please specify a Telegram channel.';
        else if (!['administrator', 'creator'].includes(member.status)) text = 'Add the bot as an administrator in the channel first.';
        else if (requiredChannels.some(c => String(c.id) === String(chat.id))) text = 'This channel is already required. Remove it first to change its link.';
        else if (!link && !chat.username) text = 'A private channel needs an invite link: /channeladd ID https://t.me/+...';
        else {
          const channels = [...requiredChannels, {id: String(chat.id), title: chat.title || chat.username || String(chat.id), url: link || `https://t.me/${chat.username}`}];
          await saveSettings(settingsWith({requiredChannels: channels})); requiredChannels = channels;
          text = `✅ Required channel added: <b>${escapeHtml(chat.title || chat.username)}</b>.`;
        }
      } catch (error) { console.error('Channel setup failed:', error.message.replaceAll(token, '[redacted]')); text = '⚠️ Could not access this channel. Check its ID and make the bot a channel administrator.'; }
    }
  } else if (command === 'channelremove') {
    if (args.length !== 1) text = 'Usage: /channelremove CHANNEL_ID (see /channels).';
    else {
      const channels = requiredChannels.filter(c => String(c.id) !== args[0]);
      if (channels.length === requiredChannels.length) text = 'Channel not found. Use /channels to see its ID.';
      else { await saveSettings(settingsWith({requiredChannels: channels})); requiredChannels = channels; text = '✅ Channel requirement removed.'; }
    }
  } else if (command === 'bot') {
    const value = args[0]?.toLowerCase();
    if (args.length !== 1 || !['on', 'off'].includes(value)) text = 'Usage: /bot on or /bot off';
    else { const enabled = value === 'on'; await saveSettings(settingsWith({botEnabled: enabled})); botEnabled = enabled; text = `✅ User replies are ${enabled ? 'on' : 'off'}. Admin commands remain available.`; }
  } else if (command === 'limit') {
    const plan = args[0]?.toLowerCase();
    const value = /^\d+$/.test(args[1] || '') ? Number(args[1]) : NaN;
    if (args.length !== 2 || !Object.hasOwn(dailyLimits, plan) || !Number.isSafeInteger(value) || value < 0 || value > 1000000) text = 'Usage: /limit free|pro NUMBER (0–1000000).';
    else { await saveSettings(settingsWith({[plan]: value})); setLimit(plan, value); text = `✅ ${escapeHtml(plan)} daily limit is now ${value}. Current usage is unchanged.`; }
  } else if (command === 'reset') {
    const id = args[0];
    if (args.length !== 1 || !id) text = 'Usage: /reset ID or /reset all';
    else if (id.toLowerCase() === 'all') { for (const user of list) resetUsage(user); await saveUsers(); text = `✅ Daily usage reset for ${list.length} users.`; }
    else if (!/^\d+$/.test(id) || !users[id]) text = 'User not found. Use /users to see recent user IDs.';
    else { resetUsage(users[id]); await saveUsers(); text = `✅ Daily usage reset for user <code>${escapeHtml(id)}</code>.`; }
  } else if (command === 'send' || command === 'broadcast') {
    const raw = message.text.replace(/^\/\S+\s*/, '');
    const match = command === 'send' ? raw.match(/^(\d+)\s+([\s\S]+)$/) : null;
    const body = (command === 'send' ? match?.[2] : raw)?.trim();
    if (!body || body.length > 4096 || (command === 'send' && !match)) {
      text = command === 'send' ? 'Usage: /send ID message (up to 4096 characters).' : 'Usage: /broadcast message (up to 4096 characters).';
    } else if (command === 'send') {
      const target = users[match[1]];
      if (!target || !target.privateChat || target.blocked) text = 'User not found, blocked, or has not contacted the bot privately.';
      else {
        try { await call('sendMessage', {chat_id: target.id, text: body}); text = `✅ Message sent to <code>${escapeHtml(target.id)}</code>.`; }
        catch (error) { console.error('Admin message failed:', error.message.replaceAll(token, '[redacted]')); text = '⚠️ Telegram could not deliver the message. The user may have blocked the bot.'; }
      }
    } else {
      const recipients = list.filter(u => u.privateChat && !u.blocked && u.id !== adminId);
      let sent = 0, failed = 0;
      await call('sendMessage', {chat_id, text:`📣 Sending to ${recipients.length} eligible users...`});
      for (const recipient of recipients) {
        try { await call('sendMessage', {chat_id: recipient.id, text: body}); sent++; }
        catch (error) { failed++; console.error('Broadcast delivery failed:', error.message.replaceAll(token, '[redacted]')); }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      text = `📣 <b>Broadcast complete</b>\n\n✅ Sent: ${sent}\n⚠️ Failed: ${failed}`;
    }
  } else {
    const id = args[0];
    const target = /^\d+$/.test(id || '') ? users[id] : null;
    if (!target) text = 'User not found. Use /users to see recent user IDs.';
    else if (command === 'user') { const q = quota(target); text = ['👤 <b>User details</b>', '', row('🆔', 'ID', target.id), row('📛', 'Name', target.name || 'Unknown'), row('🔗', 'Username', target.username ? '@' + target.username : 'None'), row('📊', 'Status', target.blocked ? 'Blocked' : 'Allowed'), row('💎', 'Plan', q.plan), row('📈', 'Checks today', `${q.used} / ${q.limit}`), row('🖼', 'Media received', target.mediaCount || 0), row('📅', 'First seen (UTC)', target.firstSeen), row('🕒', 'Last seen (UTC)', target.lastSeen)].join('\n'); }
    else if (command === 'plan') {
      const plan = args[1]?.toLowerCase();
      if (!['free', 'pro'].includes(plan) || args.length !== 2) text = 'Usage: /plan ID free|pro';
      else { target.plan = plan; await saveUsers(); const q = quota(target); text = `✅ User <code>${escapeHtml(id)}</code> is now ${escapeHtml(plan)}. Today's usage: ${q.used} / ${q.limit}.`; }
    }
    else if (target.id === adminId) text = 'The administrator cannot be blocked.';
    else { target.blocked = command === 'ban'; await saveUsers(); text = `${target.blocked ? '🚫 Blocked' : '✅ Unblocked'} user <code>${escapeHtml(id)}</code>.`; }
  }
  await call('sendMessage', {chat_id, parse_mode:'HTML', text});
}
async function probe(buffer) {
  const analyzer = await MediaInfo({ format: 'object' });
  try { return await analyzer.analyzeData(() => buffer.length, (size, offset) => buffer.subarray(offset, offset + size)); }
  finally { analyzer.close(); }
}
async function checkChannels(userId) {
  const missing = [];
  for (const channel of requiredChannels) {
    try {
      const member = await call('getChatMember', {chat_id: channel.id, user_id: userId});
      if (!['creator', 'administrator', 'member'].includes(member.status) && !(member.status === 'restricted' && member.is_member)) missing.push(channel);
    } catch (error) {
      console.error('Channel membership check failed:', error.message.replaceAll(token, '[redacted]'));
      return { error: true, missing: [] };
    }
  }
  return { error: false, missing };
}
async function showChannelRequirement(chatId, result) {
  if (result.error) {
    await call('sendMessage', {chat_id: chatId, text: '⚠️ Membership could not be verified right now. Please try again later.'});
    return;
  }
  const keyboard = result.missing.map(c => [{text: `📣 Join ${c.title}`.slice(0, 60), url: c.url}]);
  keyboard.push([{text: '✅ I joined — check again', callback_data: 'check_membership'}]);
  await call('sendMessage', {chat_id: chatId, parse_mode: 'HTML', text: '🔒 <b>Join the required channels</b>\n\nJoin each channel below, then tap the check button to continue.', reply_markup: {inline_keyboard: keyboard}});
}
async function handleCallback(query) {
  if (query.data !== 'check_membership') return;
  await call('answerCallbackQuery', {callback_query_id: query.id});
  if (!query.message?.chat?.id || !query.from || (!botEnabled && query.from.id !== adminId) || users[query.from.id]?.blocked) return;
  const result = query.from.id === adminId ? {error: false, missing: []} : await checkChannels(query.from.id);
  if (result.error || result.missing.length) await showChannelRequirement(query.message.chat.id, result);
  else await call('sendMessage', {chat_id: query.message.chat.id, text: '✅ Membership verified. Send a photo or video to check it.'});
}
async function handle(message) {
  if (!message?.chat?.id) return;
  const chat_id = message.chat.id;
  const sender = message.from;
  if (!sender || sender.is_bot) return;
  const now = new Date().toISOString();
  const user = users[sender.id] ||= {id: sender.id, firstSeen: now, mediaCount: 0, blocked: false};
  user.lastSeen = now;
  user.name = [sender.first_name, sender.last_name].filter(Boolean).join(' ');
  user.username = sender.username || '';
  if (message.chat.type === 'private') user.privateChat = true;
  const parts = (message.text || '').trim().split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase().replace(/^\//, '');
  await saveUsers();
  if (!botEnabled && sender.id !== adminId) return;
  if (parts[0].startsWith('/') && ['admin', 'users', 'user', 'ban', 'unban', 'send', 'broadcast', 'plan', 'limit', 'reset', 'bot', 'channels', 'channeladd', 'channelremove'].includes(command)) return adminCommand(message, command, parts.slice(1));
  if (user.blocked) return;
  if (sender.id !== adminId && requiredChannels.length) {
    const result = await checkChannels(sender.id);
    if (result.error || result.missing.length) { await showChannelRequirement(chat_id, result); return; }
  }
  if (parts[0].startsWith('/') && command === 'status') { const q = quota(user); await call('sendMessage', {chat_id, parse_mode:'HTML', text:`📊 <b>Your usage</b>\n\n${row('💎', 'Plan', q.plan)}\n${row('📈', 'Checks today', `${q.used} / ${q.limit}`)}\n\n🕛 Resets at midnight Tehran time.`}); return; }
  const photo = message.photo?.at(-1);
  const media = photo || message.video || message.document;
  if (!media) { await call('sendMessage', {chat_id, parse_mode:'HTML', text:'👋 <b>Welcome to Media Checker!</b>\n\nSend me a photo or video to see its size, resolution and more. Use /status to see your daily allowance.\n\n💡 Send it as a <b>file</b> to inspect the original quality.'}); return; }
  if (message.document && !/^(image|video)\//.test(media.mime_type || '')) { await call('sendMessage', {chat_id, text:'📎 Please send an image or video file.'}); return; }
  if (!consume(user)) { const q = quota(user); await call('sendMessage', {chat_id, parse_mode:'HTML', text:`⏳ <b>Daily limit reached</b>\n\nYou have used ${q.used} of ${q.limit} checks on your ${q.plan} plan. Your allowance resets at midnight Tehran time.`}); return; }
  user.mediaCount = (user.mediaCount || 0) + 1;
  await saveUsers();
  const isImage = Boolean(photo || media.mime_type?.startsWith('image/'));
  const lines = [isImage ? '🖼 <b>Photo details</b>' : '🎬 <b>Video details</b>', '', row('📦', 'Size', size(media.file_size)), row('🏷', 'Type', photo ? 'Photo' : media.mime_type || 'Video')];
  if (media.file_name) lines.push(row('📄', 'Filename', media.file_name));
  if (media.width && media.height) lines.push(row('📐', 'Resolution', `${media.width} × ${media.height} pixels`));
  if (media.duration != null) lines.push(row('⏱', 'Duration', duration(media.duration)));
  const technical = [];
  let width = media.width, height = media.height;
  try {
    if (media.file_size > 20 * 1024 * 1024) throw new Error('Telegram download limit exceeded');
    const file = await call('getFile', {file_id: media.file_id});
    if (!file.file_path) throw new Error('File path unavailable');
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!response.ok) throw new Error('Download failed');
    const info = await probe(Buffer.from(await response.arrayBuffer()));
    const tracks = info.media?.track || [];
    const general = tracks.find(s => s['@type'] === 'General');
    const video = tracks.find(s => s['@type'] === (isImage ? 'Image' : 'Video')) || tracks.find(s => s['@type'] === 'Video');
    const audio = tracks.find(s => s['@type'] === 'Audio');
    if (!media.width && video?.Width && video?.Height) lines.push(row('📐', 'Resolution', `${video.Width} × ${video.Height} pixels`));
    width = Number(video?.Width) || width; height = Number(video?.Height) || height;
    if (general?.Format && !isImage) technical.push(row('📁', 'Container', general.Format));
    if (video?.Format || (isImage && general?.Format)) technical.push(row('🎞', isImage ? 'Image format' : 'Video codec', video?.Format || general.Format));
    if (video?.Format_Profile) technical.push(row('🎛', 'Codec profile', video.Format_Profile));
    if (video?.ColorSpace) technical.push(row('🎨', 'Color space', video.ColorSpace));
    if (video?.BitDepth) technical.push(row('🌈', 'Bit depth', `${video.BitDepth} bits`));
    if (video?.ChromaSubsampling) technical.push(row('🎨', 'Chroma subsampling', video.ChromaSubsampling));
    if (!isImage && video?.BitRate && Number.isFinite(Number(video.BitRate))) technical.push(row('📹', 'Video bitrate', `${Math.round(Number(video.BitRate) / 1000)} kbps`));
    if (!isImage && video?.FrameCount) technical.push(row('🎞', 'Frame count', video.FrameCount));
    if (!isImage && video?.ScanType) technical.push(row('📺', 'Scan type', video.ScanType));
    if (video?.HDR_Format) technical.push(row('🌟', 'HDR format', video.HDR_Format));
    if (video?.colour_primaries) technical.push(row('🌈', 'Color primaries', video.colour_primaries));
    if (!isImage && video?.FrameRate) technical.push(row('🎞', 'Frame rate', `${Number(video.FrameRate).toFixed(2)} fps`));
    if (general?.OverallBitRate) technical.push(row('📊', 'Bitrate', `${Math.round(Number(general.OverallBitRate)/1000)} kbps`));
    if (audio?.Format) technical.push(row('🔊', 'Audio', `${audio.Format}${audio.SamplingRate ? `, ${audio.SamplingRate} Hz` : ''}${audio.Channels ? `, ${audio.Channels} channel(s)` : ''}`));
    if (audio?.BitRate) technical.push(row('🎵', 'Audio bitrate', `${Math.round(Number(audio.BitRate) / 1000)} kbps`));
    if (audio?.ChannelLayout) technical.push(row('🎧', 'Channel layout', audio.ChannelLayout));
    if (audio?.Language) technical.push(row('🗣', 'Audio language', audio.Language));
    const subtitles = tracks.filter(s => s['@type'] === 'Text');
    if (subtitles.length) technical.push(row('💬', 'Subtitle tracks', subtitles.length));
    if (media.duration == null && general?.Duration) lines.push(row('⏱', 'Duration', duration(general.Duration)));
    if (!technical.length) technical.push('ℹ️ No additional technical details were found.');
  } catch (error) { console.error('Media inspection failed:', error.message.replaceAll(token, '[redacted]')); technical.push(media.file_size > 20 * 1024 * 1024 || /file is too big/i.test(error.message) ? 'ℹ️ Telegram limits bot downloads to 20 MB. Details above are from Telegram.' : 'ℹ️ Additional technical details are unavailable for this file.'); }
  if (width > 0 && height > 0) {
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const divisor = gcd(width, height);
    lines.push(row('🖼', 'Aspect ratio', `${width / divisor}:${height / divisor}`));
    lines.push(row('✨', 'Pixels', `${(width * height / 1000000).toFixed(2)} megapixels`));
  }
  if (technical.length) lines.push('', '<b>🔍 Technical details</b>', ...technical);
  { const q = quota(user); lines.push('', row('📊', 'Checks today', `${q.used} / ${q.limit}`)); }
  if (photo) lines.push('', '💡 Telegram may compress photos. Send as a file for original quality.');
  await call('sendMessage', {chat_id, parse_mode:'HTML', text:lines.join('\n')});
}
let offset = 0;
console.log('Media checker started.');
while (true) {
  try {
    const updates = await call('getUpdates', {offset, timeout: 30, allowed_updates:['message', 'callback_query']});
    for (const update of updates) { offset = update.update_id + 1; await (update.callback_query ? handleCallback(update.callback_query) : handle(update.message)).catch(e => console.error('Update error:', e.message.replaceAll(token, '[redacted]'))); }
  } catch (e) { console.error('Polling error:', e.message.replaceAll(token, '[redacted]')); await new Promise(r => setTimeout(r, 5000)); }
}
