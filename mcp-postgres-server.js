import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";

// Parse command line arguments
const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    credentialsVar: 'DB_CREDENTIALS' // Default value
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
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node mcp-postgres-server.js [options]

Options:
  -c, --credentials-var VAR  Specify environment variable name containing DB credentials
                             (default: DB_CREDENTIALS)
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

Example:
  export MY_DB_CREDS='{"DB_USER":"postgres","DB_PASSWORD":"secret","DB_HOST":"localhost","DB_PORT":"5432","DB_NAME":"mydb"}'
  node mcp-postgres-server.js --credentials-var MY_DB_CREDS
      `);
      process.exit(0);
    }
  }
  
  return options;
};

const options = parseArgs();
console.log(`Using credentials from environment variable: ${options.credentialsVar}`);

// Parse DB credentials from environment variable
let dbCredentials;
try {
  // First try the specified environment variable
  const credentialsJson = process.env[options.credentialsVar] || process.env.DB_CREDENTIALS;
  
  if (!credentialsJson) {
    throw new Error(`Neither ${options.credentialsVar} nor DB_CREDENTIALS environment variables found in ~/.zshrc`);
  }
  
  try {
    dbCredentials = JSON.parse(credentialsJson);
  } catch (parseError) {
    throw new Error(`Failed to parse JSON from ${process.env[options.credentialsVar] ? options.credentialsVar : 'DB_CREDENTIALS'}: ${parseError.message}. Ensure it contains valid JSON.`);
  }
  
  console.log(`Successfully parsed database credentials from ${process.env[options.credentialsVar] ? options.credentialsVar : 'DB_CREDENTIALS'}`);
} catch (error) {
  console.error('Error with database credentials:', error.message);
  console.error('Run with --help for more information on the required format.');
  process.exit(1);
}

// Validate required database credentials
const validateCredentials = () => {
  const requiredFields = ['DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_PORT', 'DB_NAME'];
  const missingFields = requiredFields.filter(field => !dbCredentials[field]);
  
  if (missingFields.length > 0) {
    const currentVar = process.env[options.credentialsVar] ? options.credentialsVar : 'DB_CREDENTIALS';
    console.error(`Error: Missing required fields in ${currentVar}: ${missingFields.join(', ')}`);
    console.error(`The ${currentVar} environment variable must contain a JSON object with these fields.`);
    console.error('Run with --help for more information on the required format.');
    return false;
  }
  
  // Validate that port is a number
  const port = parseInt(dbCredentials.DB_PORT, 10);
  if (isNaN(port)) {
    console.error(`Error: DB_PORT must be a valid number, got: "${dbCredentials.DB_PORT}"`);
    return false;
  }
  
  return true;
};

if (!validateCredentials()) {
  console.error('Database credentials validation failed. Exiting.');
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
  console.log('Changed localhost to 127.0.0.1 to ensure IPv4 connection');
}

// Log connection details (without password)
console.log('Database configuration:', {
  user: config.user,
  host: config.host,
  port: config.port,
  database: config.database,
});

// Create a connection pool
const pool = new pg.Pool(config);

// Add event listeners for pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
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
    console.log('Testing connection to PostgreSQL database...');
    testClient = await pool.connect();
    const result = await testClient.query('SELECT 1 AS connection_test');
    console.log('Database connection test successful:', result.rows[0]);
    return true;
  } catch (err) {
    console.error('Database connection test failed:', err.message);
    
    // Provide more specific error messages based on error codes
    if (err.code === 'ECONNREFUSED') {
      console.error('Connection refused. Please check if the database server is running and accessible.');
    } else if (err.code === '28P01') {
      console.error('Authentication failed. Please check your database credentials.');
    } else if (err.code === '3D000') {
      console.error('Database does not exist. Please check the database name.');
    }
    
    console.error('Error details:', err);
    process.exit(1);
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
      console.log(`Executing query (attempt ${retries + 1}/${maxRetries}):`, sql);
      const result = await client.query(sql);
      return result;
    } catch (err) {
      lastError = err;
      console.error(`Query error (attempt ${retries + 1}/${maxRetries}):`, err.message);
      
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
    console.error('Error listing resources:', error.message);
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
    console.error('Error reading resource:', error.message);
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
        description: "Run a SQL query with retry logic",
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
      console.error('Query execution error:', error.message);
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
    await testDatabaseConnection();
    
    console.log('Starting MCP server for PostgreSQL...');
    console.log(`Using database credentials from: ${process.env[options.credentialsVar] ? options.credentialsVar : 'DB_CREDENTIALS'}`);
    console.log('To use a different credentials variable, restart with: --credentials-var YOUR_VAR_NAME');
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log('MCP server connected');
  } catch (error) {
    console.error('Server startup error:', error.message);
    console.error('Error details:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Closing database connection pool...');
  try {
    await pool.end();
    console.log('Database connection pool closed.');
  } catch (err) {
    console.error('Error closing pool:', err.message);
  }
  process.exit(0);
});

// Start the server
runServer().catch(err => {
  console.error('Unhandled error:', err);
  console.error('Error details:', err);
  process.exit(1);
}); 