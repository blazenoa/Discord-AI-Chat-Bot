// bot.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ChannelType, SlashCommandBuilder, Routes, REST, MessageFlags, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------
const STAFF_ROLE_ID = process.env.STAFF_ID;
const COOLDOWN_SECONDS = 5;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const EMBED_COLOR = 0x6F42C1;

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful, friendly assistant. Keep answers concise.';

// ---------- In‑Memory State ----------
let aiChannelId = null;
let systemPrompt = DEFAULT_SYSTEM_PROMPT;
let selectedModel = null;
let manualModelOverride = null;

const cooldowns = new Map();
const failedRequestCache = new Map();
const CACHE_TTL_MS = 30000;

// Available models list (fetched at startup)
let availableModels = [];

// ---------- Helper: Create a standard embed ----------
function createEmbed(title, description, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(title)
        .setDescription(description || null)
        .setTimestamp();
    if (options.footer) embed.setFooter({ text: options.footer });
    if (options.fields) embed.addFields(options.fields);
    return embed;
}

// ---------- Load / Save Config ----------
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            aiChannelId = data.aiChannelId || null;
            systemPrompt = data.systemPrompt || DEFAULT_SYSTEM_PROMPT;
            manualModelOverride = data.manualModel || null;
            console.log('✅ Configuration loaded');
            if (manualModelOverride) console.log(`📌 Manual model override: ${manualModelOverride}`);
        }
    } catch (err) {
        console.error('⚠️ Could not load config:', err.message);
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({
            aiChannelId,
            systemPrompt,
            manualModel: manualModelOverride
        }, null, 2));
    } catch (err) {
        console.error('⚠️ Could not save config:', err.message);
    }
}

loadConfig();

// ---------- Permission Helper ----------
function hasStaffRole(member) {
    return member.roles.cache.has(STAFF_ROLE_ID);
}

// ---------- Fetch Groq Models ----------
async function fetchGroqModels() {
    console.log('🔍 Fetching Groq models...');
    try {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
        });
        const data = await res.json();
        const models = data.data
            .filter(m => m.active)
            .map(m => m.id);
        console.log(`📋 Groq models loaded: ${models.length}`);
        return models;
    } catch (err) {
        console.error('❌ Groq fetch error:', err.message);
        return [];
    }
}

function selectBestModel(models) {
    if (models.length === 0) return null;
    const preferred = models.find(m => m.includes('llama') || m.includes('mixtral'));
    return preferred || models[0];
}

async function getEffectiveModel() {
    if (!selectedModel) {
        availableModels = await fetchGroqModels();
        selectedModel = selectBestModel(availableModels);
    }
    if (manualModelOverride) {
        if (availableModels.includes(manualModelOverride)) return manualModelOverride;
        console.warn(`⚠️ Manual model "${manualModelOverride}" not found. Falling back to auto.`);
        manualModelOverride = null;
        saveConfig();
    }
    if (!availableModels.includes(selectedModel) && availableModels.length > 0) {
        selectedModel = selectBestModel(availableModels);
    }
    return selectedModel;
}

// ---------- Groq Text Generation ----------
async function callGroqChat(modelName, userMessage) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: modelName,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ]
        })
    });
    if (!response.ok) {
        const errText = await response.text();
        throw Object.assign(new Error(`Groq API error ${response.status}: ${errText}`), { status: response.status });
    }
    const data = await response.json();
    return data.choices[0].message.content;
}

// ---------- Chat Handler ----------
async function handleChatResponse(message) {
    if (!aiChannelId || message.channel.id !== aiChannelId) return;
    if (!message.content.trim()) return;

    const now = Date.now();
    const lastUsed = cooldowns.get(message.author.id) || 0;
    if (now - lastUsed < COOLDOWN_SECONDS * 1000) return;
    cooldowns.set(message.author.id, now);

    const cacheKey = `${message.author.id}:${message.content}`;
    if (failedRequestCache.get(cacheKey) && now - failedRequestCache.get(cacheKey) < CACHE_TTL_MS) return;

    await message.channel.sendTyping();

    const currentModel = await getEffectiveModel();
    if (!currentModel) return message.reply('⚠️ No AI models are currently available.').catch(() => {});

    const fallbacks = availableModels.filter(m => m !== currentModel);
    const modelsToTry = [currentModel, ...fallbacks];
    let lastError = null;

    for (const modelName of modelsToTry) {
        let attempts = 0;
        const maxAttempts = 5;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                const text = await callGroqChat(modelName, message.content);
                console.log(`\n✅ [${modelName}] ${message.author.tag}: "${message.content}"`);
                console.log(`🤖 ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`);
                console.log('─'.repeat(50));

                let finalText = text.trim();
                if (finalText.length > 2000) finalText = finalText.substring(0, 1997) + '...';

                failedRequestCache.delete(cacheKey);
                await message.reply(finalText);
                return;

            } catch (error) {
                lastError = error;
                const status = error.status;

                if (status === 503 || status === 429) {
                    console.warn(`⚠️ ${modelName} ${status} (${attempts}/${maxAttempts})`);
                    if (attempts < maxAttempts) {
                        const delay = status === 429 ? 2 : Math.min(Math.pow(2, attempts), 32);
                        await new Promise(r => setTimeout(r, delay * 1000));
                        continue;
                    }
                }
                if (status === 404) {
                    console.warn(`⚠️ ${modelName} not found, removing from available list.`);
                    availableModels = availableModels.filter(m => m !== modelName);
                    break;
                }
                break;
            }
        }
        console.warn(`❌ ${modelName} failed after ${attempts} attempts`);
    }

    failedRequestCache.set(cacheKey, now);
    let errorMsg = '⚠️ Sorry, I encountered an error.';
    if (lastError?.status === 503) errorMsg += '\n🌩️ Service busy – try again in a minute.';
    else if (lastError?.status === 429) errorMsg += '\n📊 Quota exceeded – please wait.';
    await message.reply(errorMsg).catch(() => {});
}

// ---------- Discord Client ----------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

// ---------- Slash Commands ----------
const commands = [
    new SlashCommandBuilder().setName('help').setDescription('Show all available commands'),
    new SlashCommandBuilder()
        .setName('setchannel')
        .setDescription('Set the AI channel (Staff only)')
        .addChannelOption(opt => opt.setName('channel').setDescription('The text channel').setRequired(true).addChannelTypes(ChannelType.GuildText)),
    new SlashCommandBuilder().setName('resetchannel').setDescription('Clear the AI channel (Staff only)'),
    new SlashCommandBuilder()
        .setName('prompt')
        .setDescription('Set the system prompt (Staff only)')
        .addStringOption(opt => opt.setName('text').setDescription('New prompt').setRequired(true)),
    new SlashCommandBuilder()
        .setName('model')
        .setDescription('Manage AI model selection')
        .addSubcommand(sub => sub.setName('list').setDescription('List available models'))
        .addSubcommand(sub => sub
            .setName('set')
            .setDescription('Manually set the AI model (Staff only)')
            .addStringOption(opt => opt.setName('model').setDescription('Model name').setRequired(true)))
        .addSubcommand(sub => sub.setName('auto').setDescription('Automatic model selection (Staff only)'))
].map(cmd => cmd.toJSON());

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('🔄 Registering slash commands...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands registered');
    } catch (error) {
        console.error('❌ Command registration error:', error);
    }
}

// ---------- Events ----------
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await registerCommands();

    availableModels = await fetchGroqModels();
    if (availableModels.length === 0) console.error('❌ No Groq models available.');

    if (manualModelOverride) {
        if (availableModels.includes(manualModelOverride)) {
            selectedModel = manualModelOverride;
            console.log(`📌 Manual model: ${selectedModel}`);
        } else {
            console.warn(`⚠️ Manual model "${manualModelOverride}" not found. Switching to auto.`);
            manualModelOverride = null;
            saveConfig();
            selectedModel = selectBestModel(availableModels);
        }
    } else {
        selectedModel = selectBestModel(availableModels);
    }

    console.log(`AI Channel: ${aiChannelId ? `<#${aiChannelId}>` : 'Not set'}`);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, member } = interaction;
    const adminCommands = ['setchannel', 'resetchannel', 'prompt', 'model'];

    if (adminCommands.includes(commandName) && !hasStaffRole(member)) {
        return interaction.reply({ embeds: [createEmbed('❌ Permission Denied', 'You are not permitted to use this command.')], flags: MessageFlags.Ephemeral });
    }

    try {
        // ---------- /help (beautiful, credit at bottom) ----------
        if (commandName === 'help') {
            const isStaff = hasStaffRole(member);
            const fields = [];

            fields.push({ name: '📋 General Commands', value: '• `/model list` – View all available AI models' });
            if (isStaff) {
                fields.push({ name: '⚙️ Staff Commands', value: 
                    '• `/setchannel <channel>` – Set the AI chat channel\n' +
                    '• `/resetchannel` – Reset the AI channel\n' +
                    '• `/prompt <text>` – Change the system prompt\n' +
                    '• `/model set <model>` – Choose a specific model\n' +
                    '• `/model auto` – Use automatic model selection'
                });
            }

            // Credit link at the very bottom
            fields.push({ name: '\u200b', value: '[✨ Bot Code By BlazeNoa](https://youtube.com)' });

            const embed = createEmbed('🤖 AI Chat Bot Help', null, { fields });
            return interaction.reply({ embeds: [embed] });
        }

        // ---------- /setchannel ----------
        if (commandName === 'setchannel') {
            const channel = options.getChannel('channel', true);
            aiChannelId = channel.id;
            saveConfig();
            return interaction.reply({ embeds: [createEmbed('✅ Channel Set', `AI will now respond in ${channel}.`)] });
        }

        // ---------- /resetchannel ----------
        if (commandName === 'resetchannel') {
            aiChannelId = null;
            saveConfig();
            return interaction.reply({ embeds: [createEmbed('✅ Channel Reset', 'AI channel cleared.')] });
        }

        // ---------- /prompt ----------
        if (commandName === 'prompt') {
            const newPrompt = options.getString('text', true);
            systemPrompt = newPrompt;
            saveConfig();
            const display = newPrompt.length > 1000 ? newPrompt.substring(0, 1000) + '...' : newPrompt;
            return interaction.reply({ embeds: [createEmbed('✅ System Prompt Updated', `\`\`\`\n${display}\n\`\`\``)] });
        }

        // ---------- /model ----------
        if (commandName === 'model') {
            const sub = options.getSubcommand();

            if (sub === 'list') {
                if (availableModels.length === 0) {
                    return interaction.reply({ embeds: [createEmbed('❌ No Models', 'No Groq models are available.')] });
                }
                const modelList = availableModels.map(m => `• \`${m}\``).join('\n');
                const current = manualModelOverride ? `${manualModelOverride} (manual)` : `${selectedModel} (auto)`;

                const fields = [
                    { name: '📦 Available Models', value: modelList },
                    { name: '🔧 Currently Using', value: `**\`${current}\`**`, inline: false }
                ];

                // Credit link at bottom
                fields.push({ name: '\u200b', value: '[✨ Bot Code By BlazeNoa](https://youtube.com)' });

                const embed = createEmbed('🤖 AI Chat Bot Models', null, { fields });
                return interaction.reply({ embeds: [embed] });
            }

            if (sub === 'set') {
                const input = options.getString('model', true).trim();
                const model = availableModels.find(m => m.toLowerCase() === input.toLowerCase());
                if (!model) {
                    return interaction.reply({ embeds: [createEmbed('❌ Invalid Model', `"${input}" not found. Use \`/model list\`.`)], flags: MessageFlags.Ephemeral });
                }
                manualModelOverride = model;
                selectedModel = model;
                saveConfig();
                return interaction.reply({ embeds: [createEmbed('✅ Model Set', `Now using \`${model}\` (Groq).`)] });
            }

            if (sub === 'auto') {
                manualModelOverride = null;
                selectedModel = selectBestModel(availableModels);
                saveConfig();
                return interaction.reply({ embeds: [createEmbed('🔄 Auto Mode', `Current model: \`${selectedModel}\``)] });
            }
        }

    } catch (error) {
        console.error('Command error:', error);
        await interaction.reply({ embeds: [createEmbed('❌ Error', 'An internal error occurred.')], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
});

// Message handling – chat only
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.partial) { try { await message.fetch(); } catch { return; } }
    if (!aiChannelId || message.channel.id !== aiChannelId) return;
    await handleChatResponse(message);
});

client.on('error', console.error);
client.on('warn', console.warn);
process.on('unhandledRejection', (reason, p) => console.error('Unhandled Rejection:', p, 'reason:', reason));

client.login(process.env.DISCORD_TOKEN);