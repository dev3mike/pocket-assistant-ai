<p align="center">
  <img src="https://img.shields.io/badge/NestJS-E0234E?style=for-the-badge&logo=nestjs&logoColor=white" alt="NestJS" />
  <img src="https://img.shields.io/badge/LangChain-1C3C3C?style=for-the-badge&logo=langchain&logoColor=white" alt="LangChain" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Telegram-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram" />
</p>

<h1 align="center">Pocket Assistant AI</h1>

<p align="center">
  <strong>Your personal AI assistant that lives in your pocket.</strong><br/>
  A powerful, extensible AI agent with browser automation, coding capabilities, and smart scheduling.
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#docker">Docker</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#observability">Observability</a>
</p>

---

## What is Pocket Assistant AI?

Pocket Assistant AI is an intelligent personal assistant that runs on Telegram. It remembers your conversations, learns your preferences, and can perform complex tasks like browsing the web, writing code, and managing your schedule.

Unlike simple chatbots, Pocket Assistant uses a multi-agent architecture where specialized sub-agents handle different types of tasks:

- **Main Agent** - Orchestrates conversations and routes tasks
- **Browser Agent** - Automates web browsing with intelligent planning
- **Coder Agent** - Writes, edits, and manages code projects

---

## Features

### Intelligent Conversations
- Powered by LLMs via OpenRouter (supports GPT-4, Claude, Gemini, and more)
- Remembers conversation context with automatic memory management
- Learns your preferences through the "Soul" personalization system

### Browser Automation
- Plans and executes complex web tasks step by step
- Takes screenshots and extracts information from pages
- Handles dynamic content, forms, and multi-step workflows
- Built on Playwright for reliable browser control

### Code Assistant
- Clone repositories and work on code projects
- Read, write, and edit files with intelligent context
- Search code with grep, manage git branches
- Run commands and build scripts
- Real-time progress updates as it works

### Smart Scheduling
- Natural language: "Remind me tomorrow at 5pm"
- Recurring tasks with cron expressions
- Automatic cleanup of old schedules
- Context-aware reminders

### HTTP Requests
- Make API calls directly from chat
- Support for all HTTP methods
- Custom headers and authentication
- Perfect for checking RSS feeds, APIs, webhooks

### Security
- Whitelist-based access control
- SSRF protection for HTTP requests
- Input sanitization against prompt injection
- Sandboxed code execution environment

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Telegram Bot                              │
│                     (nestjs-telegraf)                           │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Messaging Abstraction                         │
│            (IMessagingService - extensible)                     │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Main Agent                                │
│                    (LangGraph ReAct)                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │  Tools   │  │  Memory  │  │   Soul   │  │ Scheduler│        │
│  └────┬─────┘  └──────────┘  └──────────┘  └──────────┘        │
└───────┼─────────────────────────────────────────────────────────┘
        │
        ├─────────────────┬─────────────────┐
        ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Browser Agent │ │  Coder Agent  │ │  HTTP Client  │
│  (Playwright) │ │  (Git + FS)   │ │   (fetch)     │
└───────────────┘ └───────────────┘ └───────────────┘
```

### Key Components

| Component | Description |
|-----------|-------------|
| **Main Agent** | LangGraph-based ReAct agent that handles conversations and routes to sub-agents |
| **Browser Agent** | Plans complex web tasks, executes them step-by-step with Playwright |
| **Coder Agent** | Manages code projects with file operations, git, and command execution |
| **Soul Service** | Stores user preferences and personality settings |
| **Memory Service** | Manages conversation history with automatic summarization |
| **Scheduler** | Handles reminders and recurring tasks with cron support |

---

## Quick Start

### Prerequisites

- Node.js 20+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An OpenRouter API key ([openrouter.ai](https://openrouter.ai))

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/pocket-assistant-ai.git
cd pocket-assistant-ai

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your tokens
nano .env
```

### Configuration

Edit `.env` with your credentials:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
OPENROUTER_API_KEY=your_openrouter_api_key
```

Edit `config.json` to add your Telegram user ID:

```json
{
  "security": {
    "allowedUserIds": ["YOUR_USER_ID"]
  }
}
```

> Don't know your user ID? Start the bot and send any message - it will show your ID.

### Run

```bash
# Development (with hot reload)
npm run start:dev

# Production
npm run build
npm run start:prod
```

---

## Docker

### Quick Start with Docker Compose

```bash
# Start the bot with self-hosted Langfuse observability
docker compose up -d

# Or just the bot (without Langfuse)
docker compose -f docker-compose.simple.yml up -d
```

### Build Only

```bash
docker build -t pocket-assistant-ai .
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from BotFather |
| `OPENROUTER_API_KEY` | Yes | API key from OpenRouter |
| `ZAPIER_MCP_TOKEN` | No | Zapier MCP integration token |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse public key for observability |
| `LANGFUSE_SECRET_KEY` | No | Langfuse secret key |
| `LANGFUSE_HOST` | No | Langfuse host URL |
| `ENABLE_API_CHANNEL` | No | Enable REST API alongside Telegram |

---

## Configuration

### config.json

```json
{
  "logging": {
    "enabled": false,
    "logToFile": false
  },
  "security": {
    "allowedUserIds": ["123456789"]
  },
  "model": "google/gemini-2.0-flash-001",
  "vision_model": "google/gemini-2.0-flash-001",
  "coder_model": "anthropic/claude-sonnet-4"
}
```

### Model Selection

Choose any model from [OpenRouter](https://openrouter.ai/models):

- `google/gemini-2.0-flash-001` - Fast and capable (default)
- `anthropic/claude-sonnet-4` - Great for coding
- `openai/gpt-4-turbo` - Strong reasoning
- `meta-llama/llama-3-70b` - Open source option

---

## Observability

### Langfuse Integration

Pocket Assistant integrates with [Langfuse](https://langfuse.com) for LLM observability:

- Trace all LLM calls with timing and token usage
- Debug agent reasoning and tool calls
- Monitor costs and performance

#### Using Langfuse Cloud

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com
```

#### Self-Hosted Langfuse

The included `docker-compose.yml` sets up a local Langfuse instance:

```bash
docker compose up -d
# Access Langfuse at http://localhost:3001
```

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot / Begin setup |
| `/help` | Show help message |
| `/clear` | Clear conversation history |
| `/tools` | List available tools |
| `/profile` | View your profile settings |
| `/schedules` | View scheduled reminders |
| `/resetprofile` | Reset and redo setup |

---

## Usage Examples

### Scheduling

```
You: Remind me to call mom tomorrow at 3pm
Bot: Schedule created! I'll remind you tomorrow at 3:00 PM.

You: Every Monday at 9am, remind me about standup
Bot: Recurring schedule created for every Monday at 9:00 AM.
```

### Browser Tasks

```
You: Go to Hacker News and tell me the top 3 stories
Bot: I'll browse Hacker News for you...
     [Takes screenshots, extracts information]
     Here are the top 3 stories: ...
```

### Coding

```
You: Clone github.com/user/repo and add a README file
Bot: Starting coding task...
     Using project folder: repo
     Cloning repository...
     Creating README.md...
     Done! Created README.md with project description.
```

### API Calls

```
You: Check if api.github.com is up
Bot: HTTP 200 OK
     {"current_user_url":"https://api.github.com/user"...}
```

---

## Project Structure

```
pocket-assistant-ai/
├── src/
│   ├── agent/           # Main agent orchestration
│   ├── ai/              # AI helper services
│   ├── browser/         # Browser automation agent
│   ├── coder/           # Code assistant agent
│   ├── config/          # Configuration management
│   ├── logger/          # Logging and tracing
│   ├── memory/          # Conversation memory
│   ├── messaging/       # Messaging abstraction layer
│   ├── model/           # Model factory service
│   ├── prompts/         # Prompt templates (YAML)
│   ├── scheduler/       # Task scheduling
│   ├── soul/            # User personalization
│   ├── telegram/        # Telegram integration
│   ├── usage/           # Token usage tracking
│   └── utils/           # Utilities and sanitization
├── data/
│   ├── prompts/         # YAML prompt files
│   └── {userId}/        # Per-user data storage
├── docker-compose.yml   # Full stack with Langfuse
├── Dockerfile           # Production container
└── config.json          # Application config
```

---

## Extending

### Adding New Messaging Channels

The messaging layer is abstracted via `IMessagingService`. To add a new channel (e.g., REST API, Discord):

1. Create a new service implementing `IMessagingService`
2. Register it in `MessagingModule`
3. Set `ENABLE_API_CHANNEL=true` for multi-channel mode

See `src/messaging/api-messaging.service.ts` for an example.

### Adding New Tools

Edit `src/agent/tools.service.ts`:

```typescript
private createMyNewTool(chatId: string) {
  return tool(
    async (input: { param: string }) => {
      // Your tool logic
      return 'Result';
    },
    {
      name: 'myNewTool',
      description: 'What this tool does',
      schema: z.object({
        param: z.string().describe('Parameter description'),
      }),
    },
  );
}
```

### Custom Prompts

Prompts are stored in `data/prompts/*.yaml` and support hot-reload:

```yaml
# data/prompts/main-agent.yaml
base: |
  You are a helpful AI assistant...

capabilities:
  browser: |
    You can browse the web using executeBrowserTask...
```

---

## Tech Stack

- **[NestJS](https://nestjs.com/)** - Node.js framework
- **[LangChain](https://js.langchain.com/)** - LLM framework
- **[LangGraph](https://langchain-ai.github.io/langgraphjs/)** - Agent orchestration
- **[Telegraf](https://telegraf.js.org/)** - Telegram bot framework
- **[Playwright](https://playwright.dev/)** - Browser automation
- **[OpenRouter](https://openrouter.ai/)** - LLM API gateway
- **[Langfuse](https://langfuse.com/)** - LLM observability

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  Made with <a href="https://nestjs.com/">NestJS</a> and <a href="https://langchain.com/">LangChain</a>
</p>
