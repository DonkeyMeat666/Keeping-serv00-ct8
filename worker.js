addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

addEventListener('scheduled', event => {
  event.waitUntil(handleScheduled(event.scheduledTime, event.env));
});

async function handleRequest() {
  return new Response('Worker is running');
}

async function handleScheduled(scheduledTime, env) {
  const accounts = JSON.parse(env.ACCOUNTS_JSON);  // 从环境变量获取账户数据
  const results = await loginAccounts(accounts);
  await sendSummary(results);
}

async function loginAccounts(accounts) {
  const results = [];
  for (const account of accounts) {
    const result = await loginAccount(account);
    results.push({ ...account, ...result });
    await delay(getRandomDelay()); // 随机延迟
  }
  return results;
}

function getRandomDelay() {
  return Math.floor(Math.random() * 8000) + 1000;  // 生成随机延迟时间
}

function generateRandomUserAgent() {
  const browsers = ['Chrome', 'Firefox', 'Safari', 'Edge', 'Opera'];
  const os = ['Windows NT 10.0', 'Macintosh', 'X11'];
  const selectedOS = os[Math.floor(Math.random() * os.length)];
  const osVersion = selectedOS === 'X11' ? 'Linux x86_64' : selectedOS === 'Macintosh' ? 'Intel Mac OS X 10_15_7' : 'Win64; x64';
  const browser = browsers[Math.floor(Math.random() * browsers.length)];
  const version = Math.floor(Math.random() * 100) + 1;

  return `Mozilla/5.0 (${selectedOS}; ${osVersion}) AppleWebKit/537.36 (KHTML, like Gecko) ${browser}/${version}.0.0.0 Safari/537.36`;
}

async function loginAccount(account) {
  const { username, password, panelnum, type } = account;
  const url = type === 'ct8' ? 'https://panel.ct8.pl/login/?next=/' : `https://panel${panelnum}.serv00.com/login/?next=/`;
  const userAgent = generateRandomUserAgent();

  try {
    const csrfToken = await getCsrfToken(url, userAgent);
    if (!csrfToken) throw new Error('CSRF token not found');

    const initialCookies = await getCookies(url, userAgent, csrfToken, username, password);
    const loginResponse = await attemptLogin(url, userAgent, initialCookies, csrfToken, username, password);

    if (loginResponse.status === 302) {
      return handleLoginSuccess(url, userAgent, initialCookies, loginResponse, username, type);
    } else {
      return handleLoginFailure(username, type, loginResponse);
    }
  } catch (error) {
    console.error(`Error logging in ${username}: ${error.message}`);
    await sendTelegramMessage(`登录错误: ${username} (${type}) - ${error.message}`);
    return { success: false, message: error.message };
  }
}

async function getCsrfToken(url, userAgent) {
  const response = await fetch(url, { method: 'GET', headers: { 'User-Agent': userAgent } });
  const pageContent = await response.text();
  const csrfMatch = pageContent.match(/name="csrfmiddlewaretoken" value="([^"]*)"/);
  return csrfMatch ? csrfMatch[1] : null;
}

async function getCookies(url, userAgent, csrfToken, username, password) {
  const formData = new URLSearchParams({
    username, password, csrfmiddlewaretoken: csrfToken, next: '/'
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
      'Referer': url,
    },
    body: formData.toString(),
    redirect: 'manual'
  });

  return response.headers.get('set-cookie') || '';
}

async function attemptLogin(url, userAgent, cookies, csrfToken, username, password) {
  const formData = new URLSearchParams({
    username, password, csrfmiddlewaretoken: csrfToken, next: '/'
  });

  return await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
      'Referer': url,
      'Cookie': cookies,
    },
    body: formData.toString(),
    redirect: 'manual'
  });
}

async function handleLoginSuccess(url, userAgent, initialCookies, loginResponse, username, type) {
  const allCookies = combineCookies(initialCookies, loginResponse.headers.get('set-cookie') || '');
  const dashboardContent = await fetchDashboard(url.replace('/login/', '/'), allCookies, userAgent);

  if (dashboardContent.includes('href="/logout/"') || dashboardContent.includes('href="/wyloguj/"')) {
    const message = `账号 ${username} (${type}) 登录成功！`;
    await sendTelegramMessage(message);
    return { success: true, message };
  } else {
    const message = `账号 ${username} (${type}) 登录后未找到登出链接，可能登录失败。`;
    await sendTelegramMessage(message);
    return { success: false, message };
  }
}

async function fetchDashboard(url, cookies, userAgent) {
  const response = await fetch(url, { headers: { 'Cookie': cookies, 'User-Agent': userAgent } });
  return await response.text();
}

function combineCookies(cookies1, cookies2) {
  const cookieMap = new Map();
  const parseCookies = (cookieString) => {
    cookieString.split(',').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) cookieMap.set(name.trim(), value.trim());
    });
  };

  parseCookies(cookies1);
  parseCookies(cookies2);

  return Array.from(cookieMap.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

async function handleLoginFailure(username, type, loginResponse) {
  const message = loginResponse.status === 401
    ? `账号 ${username} (${type}) 登录失败：用户名或密码错误。`
    : `账号 ${username} (${type}) 登录失败，未知原因。`;

  await sendTelegramMessage(message);
  return { success: false, message };
}

async function sendSummary(results) {
  const successfulLogins = results.filter(r => r.success);
  const failedLogins = results.filter(r => !r.success);

  let summaryMessage = `登录结果统计：\n成功登录的账号：${successfulLogins.length}\n登录失败的账号：${failedLogins.length}\n`;

  if (failedLogins.length > 0) {
    summaryMessage += '\n登录失败的账号列表：\n';
    failedLogins.forEach(({ username, type, message }) => {
      summaryMessage += `- ${username} (${type}): ${message}\n`;
    });
  }

  await sendTelegramMessage(summaryMessage);
}

async function sendTelegramMessage(message) {
  const telegramConfig = JSON.parse(env.TELEGRAM_JSON);
  const { telegramBotToken, telegramBotUserId } = telegramConfig;
  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramBotUserId, text: message })
    });
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
