import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
// Import and configure dotenv to load .env file
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '.env') });

// Parse command line arguments
const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    credentialsVar: 'DB_CREDENTIALS', // Default value
    silent: true // Default to silent mode
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--credentials-var' || args[i] === '-c') {
      if (i + 1 < args.length) {
        options.credentialsVar = args[i + 1];
        i++; // Skip the next argument as it's the value
      } else {
        console.error('Error: --credentials-var flag requires a value');
        process.exit(1);
      }
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      options.silent = false;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node server.js [options]

Options:
  -c, --credentials-var VAR  Specify environment variable name containing DB credentials
                             (default: DB_CREDENTIALS)
  -v, --verbose              Enable console logs (silent by default)
  -h, --help                 Show this help message

Environment Variables:
  The specified environment variable (or DB_CREDENTIALS as fallback) should contain
  a JSON string with the following structure:
  {
    "DB_USER": "username",
    "DB_PASSWORD": "password",
    "DB_HOST": "hostname",
    "DB_PORT": "5432",
    "DB_NAME": "database_name"
  }

Fallback Logic:
  If the environment variable is not found in the .env file, the server will
  look for it in shell config files (~/.zshrc, ~/.bashrc, ~/.bash_profile, ~/.profile).
  This is especially useful for Cursor MCP environments where shell config files
  are not automatically sourced.

Examples:
  1. Using environment variable:
     node server.js --credentials-var MY_CUSTOM_DB_CREDS
  
  2. Using .env file (default):
     node server.js
      `);
      process.exit(0);
    }
  }
  
  return options;
};

// Check if we're being run under Cursor MCP
const isCursorMCP = process.env.CURSOR_MCP === '1';

const options = parseArgs();

// Create custom logger to respect silent mode
const logger = {
  log: (...args) => {
    if (!options.silent) {
      console.log(...args);
    }
  },
  error: (...args) => {
    // Always show errors, even in silent mode
    console.error(...args);
  }
};

// Special handling for Cursor environment
if (isCursorMCP) {
  logger.log('Running in Cursor MCP environment');
}

// Function to parse DB_CREDENTIALS from shell config files
const parseShellConfigForCredentials = () => {
  // List of common shell config files to check
  const configFiles = [
    '.zshrc',
    '.bashrc',
    '.bash_profile',
    '.profile'
  ];
  
  for (const configFile of configFiles) {
    try {
      const configPath = path.join(os.homedir(), configFile);
      
      if (!fs.existsSync(configPath)) {
        logger.log(`~/${configFile} file not found`);
        continue;
      }
      
      const configContent = fs.readFileSync(configPath, 'utf8');
      
      // Enhanced regex to handle different export formats:
      // - export VAR='value'
      // - export VAR="value"
      // - export VAR=value
      const patterns = [
        // Single quotes
        new RegExp(`export\\s+(${options.credentialsVar}|[A-Z_]+DB[A-Z_]*CREDENTIALS[A-Z_]*)\\s*=\\s*'(.+?)'`, 's'),
        // Double quotes
        new RegExp(`export\\s+(${options.credentialsVar}|[A-Z_]+DB[A-Z_]*CREDENTIALS[A-Z_]*)\\s*=\\s*"(.+?)"`, 's'),
        // No quotes
        new RegExp(`export\\s+(${options.credentialsVar}|[A-Z_]+DB[A-Z_]*CREDENTIALS[A-Z_]*)\\s*=\\s*({.+?})`, 's')
      ];
      
      for (const regex of patterns) {
        const match = configContent.match(regex);
        
        if (match && match.length >= 3) {
          const varName = match[1];
          const credentialsJson = match[2];
          
          logger.log(`Found ${varName} in ~/${configFile}`);
          
          try {
            const credentials = JSON.parse(credentialsJson);
            return credentials;
          } catch (parseError) {
            logger.error(`Failed to parse JSON from ${varName} in ~/${configFile}: ${parseError.message}`);
            // Continue trying other patterns or files
          }
        }
      }
    } catch (error) {
      logger.error(`Error reading ~/${configFile}: ${error.message}`);
      // Continue with next config file
    }
  }
  
  return null;
};

// Parse DB credentials from environment variable, .env file, or shell config files
let dbCredentials;
try {
  // Try to get credentials from environment variable
  const credentialsJson = process.env[options.credentialsVar];
  
  if (!credentialsJson) {
    logger.log(`${options.credentialsVar} environment variable not found. Checking shell config files as fallback...`);
    
    // Try to get credentials from shell config files
    dbCredentials = parseShellConfigForCredentials();
    
    if (!dbCredentials) {
      throw new Error(`${options.credentialsVar} not found in environment variables or shell config files.`);
    }
    
    logger.log('Successfully parsed database credentials from shell config file');
  } else {
    try {
      dbCredentials = JSON.parse(credentialsJson);
      if (!options.silent) {
        logger.log(`Successfully parsed database credentials from ${options.credentialsVar} environment variable`);
      }
    } catch (parseError) {
      throw new Error(`Failed to parse JSON from ${options.credentialsVar}: ${parseError.message}. Ensure it contains valid JSON.`);
    }
  }
} catch (error) {
  logger.error('Error with database credentials:', error.message);
  logger.error('Make sure your .env file is set up correctly with the DB_CREDENTIALS variable,');
  logger.error('or ensure DB_CREDENTIALS is properly exported in your shell config file (~/.zshrc, ~/.bashrc, etc.).');
  logger.error('Run with --help for more information on the required format.');
  process.exit(1);
}

// Validate required database credentials
const validateCredentials = () => {
  const requiredFields = ['DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_PORT', 'DB_NAME'];
  const missingFields = requiredFields.filter(field => !dbCredentials[field]);
  
  if (missingFields.length > 0) {
    logger.error(`Error: Missing required fields in ${options.credentialsVar}: ${missingFields.join(', ')}`);
    logger.error(`The ${options.credentialsVar} environment variable must contain a JSON object with these fields.`);
    logger.error('Run with --help for more information on the required format.');
    return false;
  }
  
  // Validate that port is a number
  const port = parseInt(dbCredentials.DB_PORT, 10);
  if (isNaN(port)) {
    logger.error(`Error: DB_PORT must be a valid number, got: "${dbCredentials.DB_PORT}"`);
    return false;
  }
  
  return true;
};

if (!validateCredentials()) {
  logger.error('Database credentials validation failed. Exiting.');
  process.exit(1);
}

// Database connection configuration
const config = {
  user: dbCredentials.DB_USER,
  password: dbCredentials.DB_PASSWORD,
  host: dbCredentials.DB_HOST,
  port: parseInt(dbCredentials.DB_PORT, 10),
  database: dbCredentials.DB_NAME,
  // Add connection timeout and retry settings
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10, // Maximum number of clients in the pool
};

// Ensure localhost is using IPv4
if (config.host === 'localhost') {
  config.host = '127.0.0.1';
  logger.log('Changed localhost to 127.0.0.1 to ensure IPv4 connection');
}

// Log connection details (without password)
if (!options.silent) {
  logger.log('Database configuration:', {
    user: config.user,
    host: config.host,
    port: config.port,
    database: config.database,
  });
}

// Create a connection pool
const pool = new pg.Pool(config);

// Add event listeners for pool errors
pool.on('error', (err) => {
  logger.error('Unexpected error on idle client', err);
});

// Create the MCP server
const server = new Server(
  {
    name: "cursor-mcp-postgres",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

// Construct a resource base URL for the database
const resourceBaseUrl = new URL(`postgres://${config.user}@${config.host}:${config.port}/${config.database}`);
resourceBaseUrl.protocol = "postgres:";
resourceBaseUrl.password = "";

const SCHEMA_PATH = "schema";

// Test database connection
async function testDatabaseConnection() {
  let testClient = null;
  try {
    logger.log('Testing connection to PostgreSQL database...');
    testClient = await pool.connect();
    const result = await testClient.query('SELECT 1 AS connection_test');
    logger.log('Database connection test successful:', result.rows[0]);
    return true;
  } catch (err) {
    logger.error('Database connection test failed:', err.message);
    
    // Provide more specific error messages based on error codes
    if (err.code === 'ECONNREFUSED') {
      logger.error('Connection refused. Please check if the database server is running and accessible.');
    } else if (err.code === '28P01') {
      logger.error('Authentication failed. Please check your database credentials.');
    } else if (err.code === '3D000') {
      logger.error('Database does not exist. Please check the database name.');
    }
    
    logger.error('Error details:', err);
    
    // Don't exit immediately in Cursor environment to allow showing the error
    if (!isCursorMCP) {
      process.exit(1);
    }
    return false;
  } finally {
    if (testClient) {
      testClient.release();
    }
  }
}

// Execute a query with retry logic
async function executeQueryWithRetry(sql, maxRetries = 3) {
  let retries = 0;
  let lastError = null;

  while (retries < maxRetries) {
    const client = await pool.connect();
    try {
      logger.log(`Executing query (attempt ${retries + 1}/${maxRetries}):`, sql);
      const result = await client.query(sql);
      return result;
    } catch (err) {
      lastError = err;
      logger.error(`Query error (attempt ${retries + 1}/${maxRetries}):`, err.message);
      
      // Check if this is a connection-related error that might be resolved by retrying
      if (err.code === 'ECONNREFUSED' || err.code === '57P01' || err.code === '08006' || err.code === '08001') {
        retries++;
        await new Promise(resolve => setTimeout(resolve, 1000 * retries)); // Exponential backoff
      } else {
        // For other errors, don't retry
        throw err;
      }
    } finally {
      client.release();
    }
  }
  
  // If we've exhausted all retries
  throw lastError;
}

// Handler for listing database resources (tables)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return {
      resources: result.rows.map((row) => ({
        uri: new URL(`${row.table_name}/${SCHEMA_PATH}`, resourceBaseUrl).href,
        mimeType: "application/json",
        name: `"${row.table_name}" database schema`,
      })),
    };
  } catch (error) {
    logger.error('Error listing resources:', error.message);
    throw error;
  } finally {
    client.release();
  }
});

// Handler for reading resource details (table schema)
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourceUrl = new URL(request.params.uri);

  const pathComponents = resourceUrl.pathname.split("/");
  const schema = pathComponents.pop();
  const tableName = pathComponents.pop();

  if (schema !== SCHEMA_PATH) {
    throw new Error("Invalid resource URI");
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
      [tableName],
    );

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(result.rows, null, 2),
        },
      ],
    };
  } catch (error) {
    logger.error('Error reading resource:', error.message);
    throw error;
  } finally {
    client.release();
  }
});

// Handler for listing available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Run a SQL query against the PostgreSQL database",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string" },
          },
          required: ["sql"],
        },
      },
    ],
  };
});

// Handler for executing tool calls (SQL queries)
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "query") {
    // Use type assertion in a way that works in JavaScript
    const sql = request.params.arguments?.sql;
    
    if (!sql || typeof sql !== 'string') {
      throw new Error("SQL query is required and must be a string");
    }

    try {
      // Use our retry logic for query execution
      const result = await executeQueryWithRetry(sql);
      
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        isError: false,
      };
    } catch (error) {
      logger.error('Query execution error:', error.message);
      return {
        content: [{ type: "text", text: `Error executing query: ${error.message}` }],
        isError: true,
      };
    }
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Main function to run the server
async function runServer() {
  try {
    // Test database connection before starting
    const connectionSuccess = await testDatabaseConnection();
    
    // In Cursor, we proceed even if the connection test fails to show errors
    if (!isCursorMCP || connectionSuccess) {
      logger.log('Starting MCP server for PostgreSQL...');
      
      // Create the transport
      const transport = new StdioServerTransport();
      
      try {
        // Connect to the transport
        await server.connect(transport);
        logger.log('MCP server connected and ready to use');
      } catch (transportError) {
        logger.error('Failed to connect to MCP transport:', transportError.message);
        if (!isCursorMCP) {
          process.exit(1);
        }
      }
    }
  } catch (error) {
    logger.error('Server startup error:', error.message);
    logger.error('Error details:', error);
    if (!isCursorMCP) {
      process.exit(1);
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.log('Closing database connection pool...');
  try {
    await pool.end();
    logger.log('Database connection pool closed.');
  } catch (err) {
    logger.error('Error closing pool:', err.message);
  }
  process.exit(0);
});

// Start the server
runServer().catch(err => {
  logger.error('Unhandled error:', err);
  logger.error('Error details:', err);
  if (!isCursorMCP) {
    process.exit(1);
  }
}); 