# Pocket Assistant AI

A personal AI assistant Telegram bot built with NestJS and LangChain. It remembers your conversations, uses tools to help you, and can be customized to match your personality preferences.

## Features

### AI Chat
- Powered by LLM models via OpenRouter (default: Google Gemini)
- Remembers conversation context (30-minute timeout)
- Supports Markdown formatting in responses

### Personalization (Soul System)
- First-time setup asks you to customize the AI
- Set the AI's name and personality
- Tell the AI about yourself
- All settings saved to `data/{userId}/soul.json`
- AI uses this info in every conversation

### Security
- Whitelist-based access control
- Only approved users can use the bot
- Unauthorized users see their User ID to request access

### Tools
The AI can use these tools to help you:

| Tool | Description |
|------|-------------|
| `getCurrentDate` | Get current date and time |
| `setLogging` | Enable or disable logging |
| `getProfile` | View your profile settings |
| `updateProfile` | Update AI name, personality, or user info |
| `createSchedule` | Schedule reminders and tasks |
| `listSchedules` | View active scheduled tasks |
| `cancelSchedule` | Cancel a scheduled task |

### Scheduler (Reminders & Tasks)
- Schedule one-time or recurring reminders
- Natural language support: "remind me tomorrow at 5pm"
- Recurring tasks with cron expressions
- Limit executions: "remind me 10 times"
- Automatic cleanup of old cancelled tasks (after 7 days)
- All schedules saved to `data/{userId}/schedules.json`

**Examples:**
- "Remind me to call mom tomorrow at 3pm"
- "Every Monday at 9am, remind me about team standup"
- "Remind me to take medication every day at 8am and 8pm"
- "Remind me about the deadline 5 times, daily at 10am"

### Zapier Integration (Optional)
- Connect to Zapier MCP for email, calendar, and more
- Requires Zapier MCP token

### Logging
- Console logging (off by default)
- File logging to `logs/YYYY-MM-DD.json`
- Enable via chat: "enable logging" or "enable file logging"

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Environment File

Create a `.env` file in the project root:

```env
# Required
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
OPENROUTER_API_KEY=your_openrouter_api_key

# Optional - for Zapier integration
ZAPIER_MCP_TOKEN=your_zapier_mcp_token
```

**Get your tokens:**
- Telegram: Talk to [@BotFather](https://t.me/BotFather) on Telegram
- OpenRouter: Sign up at [openrouter.ai](https://openrouter.ai)
- Zapier MCP: Get from Zapier's MCP integration (optional)

### 3. Configure Allowed Users

Edit `config.json` to add your Telegram User ID:

```json
{
  "logging": {
    "enabled": false,
    "logToFile": false
  },
  "security": {
    "allowedUserIds": ["YOUR_USER_ID"]
  }
}
```

**How to find your User ID:**
1. Start the bot without your ID in the config
2. Send any message to the bot
3. The bot will show you your User ID
4. Add it to `config.json` and restart

### 4. Run the Bot

```bash
# Development (with hot reload)
npm run start:dev

# Production
npm run build
npm run start:prod
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot / Begin setup |
| `/help` | Show help message |
| `/clear` | Clear conversation history |
| `/tools` | List available tools |
| `/profile` | View your profile settings |
| `/schedules` | View scheduled reminders |
| `/resetprofile` | Reset and redo setup |

### First Time Setup

When you first start the bot, it will ask you 5 questions:

1. **AI Name** - What should the AI be called?
2. **AI Personality** - How should the AI behave? (e.g., "friendly", "professional")
3. **Your Name** - What's your name?
4. **About You** - Tell the AI about yourself
5. **Additional Context** - Any preferences? (e.g., "keep responses short")

### Example Conversations

**Ask for the date:**
> You: What's today's date?
> AI: Today is February 3, 2026.

**Set a reminder:**
> You: Remind me to call the dentist tomorrow at 2pm
> AI: ✅ Schedule created! I'll remind you tomorrow at 2:00 PM to call the dentist.

**Recurring reminder:**
> You: Every day at 9am, remind me to check my emails
> AI: ✅ Schedule created! I'll remind you every day at 9:00 AM to check your emails.

**View schedules:**
> You: What reminders do I have?
> AI: You have 2 active schedules: [lists them]

**Enable logging:**
> You: Turn on logging
> AI: Logging has been enabled. You will now see detailed logs in the console.

**Chat normally:**
> You: Help me write an email to my boss about taking time off
> AI: Here's a draft email for requesting time off...

## Project Structure

```
pocket-assistant-ai/
├── src/
│   ├── agent/
│   │   ├── agent.module.ts      # Agent module
│   │   ├── agent.service.ts     # LLM agent logic
│   │   └── tools.service.ts     # Tool definitions
│   ├── ai/
│   │   ├── ai.module.ts         # AI module
│   │   └── ai.service.ts        # AI helper functions
│   ├── config/
│   │   ├── config.module.ts     # Config module
│   │   └── config.service.ts    # App configuration
│   ├── logger/
│   │   ├── logger.module.ts     # Logger module
│   │   └── agent-logger.service.ts  # Logging service
│   ├── scheduler/
│   │   ├── scheduler.module.ts  # Scheduler module
│   │   └── scheduler.service.ts # Scheduled tasks & reminders
│   ├── soul/
│   │   ├── soul.module.ts       # Soul module
│   │   └── soul.service.ts      # User personalization
│   ├── telegram/
│   │   ├── telegram.module.ts   # Telegram module
│   │   ├── telegram.service.ts  # Proactive messaging
│   │   └── telegram.update.ts   # Message handlers
│   ├── app.module.ts            # Main app module
│   └── main.ts                  # Entry point
├── data/
│   └── {userId}/
│       ├── soul.json            # User profile data
│       ├── schedules.json       # Scheduled tasks
│       ├── memory.json          # Conversation memory
│       └── usage.json           # Token usage tracking
├── logs/                        # Log files (when enabled)
├── config.json                  # App configuration
├── .env                         # Environment variables
└── package.json
```

## Configuration

### config.json

```json
{
  "logging": {
    "enabled": false,      // Console logging
    "logToFile": false     // File logging
  },
  "security": {
    "allowedUserIds": []   // Telegram User IDs
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from BotFather |
| `OPENROUTER_API_KEY` | Yes | API key from OpenRouter |
| `ZAPIER_MCP_TOKEN` | No | Token for Zapier MCP integration |

## Adding More Users

To allow more people to use your bot:

1. Ask them to message the bot
2. They will see their User ID in the access denied message
3. Add their User ID to `config.json`:

```json
{
  "security": {
    "allowedUserIds": ["123456789", "987654321"]
  }
}
```

4. The new user can now use the bot (no restart needed)

## Logging

### Enable via Chat
- Say "enable logging" to turn on console logs
- Say "enable file logging" to save logs to files
- Say "what's the logging status" to check current settings

### Log Files
When file logging is enabled, logs are saved to:
```
logs/2026-02-03.json
```

Each log entry includes:
- Timestamp
- Event type (message received, tool called, etc.)
- User chat ID
- Additional data

## Customization

### Change the AI Model

Edit `src/agent/agent.service.ts`:

```typescript
this.model = new ChatOpenAI({
  model: 'google/gemini-3-flash-preview',  // Change this
  temperature: 0,
  configuration: {
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  },
});
```

Available models on OpenRouter:
- `google/gemini-3-flash-preview`
- `anthropic/claude-3-opus`
- `openai/gpt-4-turbo`
- And many more at [openrouter.ai/models](https://openrouter.ai/models)

### Add New Tools

Edit `src/agent/tools.service.ts`:

```typescript
getLocalTools(): Record<string, any> {
  return {
    getCurrentDate: this.createGetCurrentDateTool(),
    // Add your new tool here
    myNewTool: this.createMyNewTool(),
  };
}

private createMyNewTool() {
  return tool(
    (input) => {
      // Your tool logic here
      return 'Tool result';
    },
    {
      name: 'myNewTool',
      description: 'Description of what this tool does',
    },
  );
}
```

## Troubleshooting

### Bot doesn't respond
- Check if your User ID is in `config.json`
- Check if `TELEGRAM_BOT_TOKEN` is correct
- Look at console for error messages

### "Access Denied" message
- Your User ID is not in the allowed list
- Add your ID to `config.json` → `security.allowedUserIds`

### Zapier tools not loading
- Check if `ZAPIER_MCP_TOKEN` is set correctly
- The bot will continue working without Zapier tools

### Markdown not rendering
- Some special characters can break Markdown
- The bot will fall back to plain text if Markdown fails

## License

UNLICENSED - Private project

## Tech Stack

- [NestJS](https://nestjs.com/) - Node.js framework
- [Telegraf](https://telegraf.js.org/) - Telegram bot framework
- [LangChain](https://js.langchain.com/) - LLM framework
- [LangGraph](https://langchain-ai.github.io/langgraphjs/) - Agent orchestration
- [OpenRouter](https://openrouter.ai/) - LLM API gateway
# pocket-assistant-ai
