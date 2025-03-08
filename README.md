# Model Context Protocol PostgreSQL Server

This project implements a Model Context Protocol (MCP) server that connects to a PostgreSQL database. It allows AI models to interact with your database through a standardized protocol.

## Features

- Connects to a PostgreSQL database using connection pooling
- Implements the Model Context Protocol for AI model interaction
- Provides database schema information as resources
- Allows executing SQL queries with retry logic
- Handles connection errors gracefully

## Prerequisites

- Node.js 20 or higher
- PostgreSQL database
- Access credentials for the database

## Installation

1. Clone this repository
2. Install dependencies:

```bash
npm install
```

## Configuration

Edit the database configuration in `mcp-postgres-server.js`:

```javascript
const config = {
  user: 'your-username',
  password: 'your-password',
  host: 'your-host',
  port: 5433,
  database: 'your-database',
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
};
```

## Usage

Start the MCP server:

```bash
npm start
```

The server will:
1. Test the database connection
2. Start the MCP server using stdio transport
3. Handle requests from AI models

## Available Tools

The server provides the following tools to AI models:

- `query`: Execute SQL queries with retry logic

## Resources

The server exposes database tables as resources, allowing AI models to:

- List all tables in the database
- View schema information for each table

## Error Handling

The server includes:
- Connection retry logic
- Detailed error logging
- Graceful shutdown handling

## License

MIT 