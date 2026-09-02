// GENERATED FILE. DO NOT EDIT.
// Source authority: services/mcp-gateway/src/mcp/server.ts createMcpServer() + canonical Gateway auth config.

export const EDGE_MCP_REQUIRED_SCOPE = "workspaces:read" as const;

export const EDGE_MCP_TOOL_MANIFEST = [
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Lists enabled top-level workspaces authorized in the connected local agent. Use this for initial workspace discovery. workspaceKind distinguishes repository from aggregate; when an aggregate root is not already known, use list_workspace_roots next instead of recursive traversal.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    },
    "name": "list_workspaces",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "workspaces": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "allowedShells": {
                "items": {
                  "enum": [
                    "powershell",
                    "pwsh",
                    "cmd",
                    "wsl",
                    "git-bash"
                  ],
                  "type": "string"
                },
                "type": "array"
              },
              "confirmationMode": {
                "enum": [
                  "standard",
                  "trusted-workspace"
                ],
                "type": "string"
              },
              "enabled": {
                "const": true,
                "type": "boolean"
              },
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "permissionProfile": {
                "enum": [
                  "planning-readonly",
                  "planning-handoff",
                  "builder-review",
                  "restricted-area",
                  "full-repo-readonly",
                  "full-repo-write"
                ],
                "type": "string"
              },
              "shellsEnabled": {
                "type": "boolean"
              },
              "workspaceKind": {
                "enum": [
                  "repository",
                  "aggregate"
                ],
                "type": "string"
              },
              "writesEnabled": {
                "type": "boolean"
              }
            },
            "required": [
              "id",
              "name",
              "enabled",
              "permissionProfile",
              "confirmationMode",
              "writesEnabled",
              "shellsEnabled",
              "allowedShells"
            ],
            "type": "object"
          },
          "type": "array"
        }
      },
      "required": [
        "workspaces"
      ],
      "type": "object"
    },
    "title": "List workspaces"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Lists immediate authorized first-level directories without recursive traversal. Use this only when workspaceKind=aggregate and a concrete root is not already known. If the root is already known, skip this tool and pass that root directly to get_workspace_context, list_files, search_files, inspect_workspace_git or other root-aware tools. After discovery, pass one returned root to the operation that needs it.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "type": "object"
    },
    "name": "list_workspace_roots",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "roots": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "truncated": {
          "type": "boolean"
        }
      },
      "required": [
        "roots",
        "truncated"
      ],
      "type": "object"
    },
    "title": "List workspace roots"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Lists files within a workspace. Paths are relative to the workspace root (never prefix with the workspace id). For aggregate workspaces, never call without a concrete root: if the root is unknown, call list_workspace_roots first; if it is already known, pass it directly. root=\".\" is equivalent to omitting root and is therefore not a concrete aggregate root. glob is matched against the full logical path relative to the workspace root, not only the basename and not relative to the selected root; for example root=\"repo-a\" with glob=\"package.json\" does not match repo-a/package.json, while glob=\"repo-a/package.json\" or glob=\"**/package.json\" does. Operational artifact directories (runtime, releases, .runtime-tools) are omitted from implicit discovery; request one explicitly with root when needed.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "glob": {
          "minLength": 1,
          "type": "string"
        },
        "root": {
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "type": "object"
    },
    "name": "list_files",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "files": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "truncated": {
          "type": "boolean"
        }
      },
      "required": [
        "files",
        "truncated"
      ],
      "type": "object"
    },
    "title": "List files"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Reads text content from a workspace file (UTF-8, Windows-1252/ANSI, Latin-1). path is relative to the workspace root.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "endLine": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "path": {
          "minLength": 1,
          "type": "string"
        },
        "startLine": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "path"
      ],
      "type": "object"
    },
    "name": "read_file",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "content": {
          "type": "string"
        },
        "encoding": {
          "enum": [
            "utf-8",
            "utf-16le",
            "utf-16be",
            "windows-1252",
            "latin1"
          ],
          "type": "string"
        },
        "endLine": {
          "maximum": 9007199254740991,
          "minimum": -9007199254740991,
          "type": "integer"
        },
        "lineEnding": {
          "enum": [
            "lf",
            "crlf",
            "cr",
            "mixed",
            "none"
          ],
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "sha256": {
          "pattern": "^[a-f0-9]{64}$",
          "type": "string"
        },
        "sizeBytes": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "startLine": {
          "maximum": 9007199254740991,
          "minimum": -9007199254740991,
          "type": "integer"
        },
        "totalLines": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "path",
        "content",
        "startLine",
        "endLine",
        "totalLines",
        "sizeBytes",
        "sha256",
        "encoding",
        "lineEnding"
      ],
      "type": "object"
    },
    "title": "Read file"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Creates or overwrites a text file inside the workspace. path is relative to the workspace root. Writes are allowed only when the workspace policy enables allowWrites (for example under Desktop/Project).",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "content": {
          "type": "string"
        },
        "path": {
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "path",
        "content"
      ],
      "type": "object"
    },
    "name": "write_file",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "created": {
          "type": "boolean"
        },
        "path": {
          "type": "string"
        },
        "sizeBytes": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "path",
        "sizeBytes",
        "created"
      ],
      "type": "object"
    },
    "title": "Write file"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Runs a predefined, read-only validation in an authorized workspace. Available validations are diff-check, legacy-format, legacy-compat and secret-scan. The validation name selects a fixed implementation; arbitrary commands are not accepted.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "maxFindings": {
          "default": 100,
          "exclusiveMinimum": 0,
          "maximum": 200,
          "type": "integer"
        },
        "paths": {
          "default": [],
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 20,
          "type": "array"
        },
        "root": {
          "default": ".",
          "minLength": 1,
          "type": "string"
        },
        "scope": {
          "default": "changes",
          "enum": [
            "changes",
            "paths",
            "repository"
          ],
          "type": "string"
        },
        "timeoutMs": {
          "default": 60000,
          "exclusiveMinimum": 0,
          "maximum": 300000,
          "type": "integer"
        },
        "validation": {
          "enum": [
            "diff-check",
            "legacy-format",
            "legacy-compat",
            "secret-scan"
          ],
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "validation"
      ],
      "type": "object"
    },
    "name": "run_workspace_validation",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "durationMs": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "executed": {
          "type": "boolean"
        },
        "filesScanned": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "findings": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "column": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              },
              "fingerprint": {
                "minLength": 1,
                "type": "string"
              },
              "line": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              },
              "message": {
                "minLength": 1,
                "type": "string"
              },
              "path": {
                "minLength": 1,
                "type": "string"
              },
              "ruleId": {
                "minLength": 1,
                "type": "string"
              },
              "severity": {
                "enum": [
                  "info",
                  "warning",
                  "error"
                ],
                "type": "string"
              },
              "source": {
                "enum": [
                  "git",
                  "format",
                  "ast-grep",
                  "gitleaks"
                ],
                "type": "string"
              }
            },
            "required": [
              "ruleId",
              "severity",
              "message",
              "path",
              "source"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "findingsCount": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "issues": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "passed": {
          "type": "boolean"
        },
        "root": {
          "minLength": 1,
          "type": "string"
        },
        "scope": {
          "enum": [
            "changes",
            "paths",
            "repository"
          ],
          "type": "string"
        },
        "tool": {
          "additionalProperties": false,
          "properties": {
            "available": {
              "type": "boolean"
            },
            "name": {
              "minLength": 1,
              "type": "string"
            },
            "version": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "name",
            "available"
          ],
          "type": "object"
        },
        "truncated": {
          "type": "boolean"
        },
        "validation": {
          "enum": [
            "diff-check",
            "legacy-format",
            "legacy-compat",
            "secret-scan"
          ],
          "type": "string"
        },
        "warnings": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "root",
        "validation",
        "scope",
        "executed",
        "passed",
        "tool",
        "filesScanned",
        "findings",
        "findingsCount",
        "truncated",
        "durationMs",
        "issues",
        "warnings"
      ],
      "type": "object"
    },
    "title": "Run workspace validation"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Preferred general command runner for new routing decisions. Executes a command in an allowed shell with the workspace root as the default working directory. Use it when shell selection, qualified execution, safe autocorrection or expectedOutcome checks are useful; it can run PowerShell as well as pwsh, cmd, wsl and git-bash. Use run_powershell only when the task specifically requires the simpler compatibility PowerShell-only surface. Commands classified as potentially destructive return confirmation_required before execution.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "autoCorrection": {
          "enum": [
            "off",
            "safe"
          ],
          "type": "string"
        },
        "command": {
          "maxLength": 32000,
          "minLength": 1,
          "type": "string"
        },
        "confirmationId": {
          "maxLength": 128,
          "minLength": 1,
          "type": "string"
        },
        "cwd": {
          "minLength": 1,
          "type": "string"
        },
        "executionMode": {
          "enum": [
            "direct",
            "qualified"
          ],
          "type": "string"
        },
        "expectedOutcome": {
          "items": {
            "oneOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "exit_code",
                    "type": "string"
                  },
                  "value": {
                    "maximum": 9007199254740991,
                    "minimum": -9007199254740991,
                    "type": "integer"
                  }
                },
                "required": [
                  "kind",
                  "value"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "file_exists",
                    "type": "string"
                  },
                  "path": {
                    "maxLength": 4096,
                    "minLength": 1,
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "path"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "file_absent",
                    "type": "string"
                  },
                  "path": {
                    "maxLength": 4096,
                    "minLength": 1,
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "path"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "sha256",
                    "type": "string"
                  },
                  "path": {
                    "maxLength": 4096,
                    "minLength": 1,
                    "type": "string"
                  },
                  "value": {
                    "pattern": "^[a-f0-9]{64}$",
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "path",
                  "value"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "text_contains",
                    "type": "string"
                  },
                  "stream": {
                    "enum": [
                      "stdout",
                      "stderr"
                    ],
                    "type": "string"
                  },
                  "value": {
                    "maxLength": 4096,
                    "minLength": 1,
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "stream",
                  "value"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "json_field",
                    "type": "string"
                  },
                  "path": {
                    "maxLength": 4096,
                    "minLength": 1,
                    "type": "string"
                  },
                  "pointer": {
                    "maxLength": 1024,
                    "minLength": 1,
                    "type": "string"
                  },
                  "value": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "number"
                      },
                      {
                        "type": "boolean"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "kind",
                  "path",
                  "pointer",
                  "value"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "git_clean",
                    "type": "string"
                  },
                  "root": {
                    "default": ".",
                    "maxLength": 4096,
                    "minLength": 1,
                    "type": "string"
                  }
                },
                "required": [
                  "kind"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "process_exited",
                    "type": "string"
                  },
                  "pid": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer"
                  }
                },
                "required": [
                  "kind",
                  "pid"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "http_status",
                    "type": "string"
                  },
                  "url": {
                    "format": "uri",
                    "type": "string"
                  },
                  "value": {
                    "maximum": 599,
                    "minimum": 100,
                    "type": "integer"
                  }
                },
                "required": [
                  "kind",
                  "url",
                  "value"
                ],
                "type": "object"
              },
              {
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "duration_lte",
                    "type": "string"
                  },
                  "valueMs": {
                    "maximum": 9007199254740991,
                    "minimum": 0,
                    "type": "integer"
                  }
                },
                "required": [
                  "kind",
                  "valueMs"
                ],
                "type": "object"
              }
            ]
          },
          "maxItems": 20,
          "type": "array"
        },
        "objective": {
          "maxLength": 4000,
          "minLength": 1,
          "type": "string"
        },
        "preferredShell": {
          "anyOf": [
            {
              "enum": [
                "powershell",
                "pwsh",
                "cmd",
                "wsl",
                "git-bash"
              ],
              "type": "string"
            },
            {
              "const": "auto",
              "type": "string"
            }
          ]
        },
        "shell": {
          "enum": [
            "powershell",
            "pwsh",
            "cmd",
            "wsl",
            "git-bash"
          ],
          "type": "string"
        },
        "timeoutMs": {
          "default": 60000,
          "exclusiveMinimum": 0,
          "maximum": 86400000,
          "type": "integer"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "type": "object"
    },
    "name": "run_command",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "attemptCount": {
          "maximum": 2,
          "minimum": 1,
          "type": "integer"
        },
        "attempts": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "attempt": {
                "maximum": 2,
                "minimum": 1,
                "type": "integer"
              },
              "completedAt": {
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                "type": "string"
              },
              "cwd": {
                "minLength": 1,
                "type": "string"
              },
              "exitCode": {
                "anyOf": [
                  {
                    "maximum": 9007199254740991,
                    "minimum": -9007199254740991,
                    "type": "integer"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "planFingerprint": {
                "pattern": "^[a-f0-9]{64}$",
                "type": "string"
              },
              "shell": {
                "enum": [
                  "powershell",
                  "pwsh",
                  "cmd",
                  "wsl",
                  "git-bash"
                ],
                "type": "string"
              },
              "startedAt": {
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                "type": "string"
              },
              "timedOut": {
                "type": "boolean"
              }
            },
            "required": [
              "attempt",
              "planFingerprint",
              "shell",
              "cwd",
              "exitCode",
              "timedOut",
              "startedAt",
              "completedAt"
            ],
            "type": "object"
          },
          "maxItems": 2,
          "type": "array"
        },
        "confirmationId": {
          "type": "string"
        },
        "corrected": {
          "type": "boolean"
        },
        "correction": {
          "additionalProperties": false,
          "properties": {
            "applied": {
              "type": "boolean"
            },
            "blockedReason": {
              "maxLength": 1000,
              "minLength": 1,
              "type": "string"
            },
            "effectiveCommand": {
              "maxLength": 32000,
              "minLength": 1,
              "type": "string"
            },
            "effectiveCwd": {
              "maxLength": 4096,
              "minLength": 1,
              "type": "string"
            },
            "effectiveShell": {
              "enum": [
                "powershell",
                "pwsh",
                "cmd",
                "wsl",
                "git-bash"
              ],
              "type": "string"
            },
            "sanitized": {
              "type": "boolean"
            }
          },
          "required": [
            "applied",
            "sanitized"
          ],
          "type": "object"
        },
        "cwd": {
          "type": "string"
        },
        "diagnosis": {
          "additionalProperties": false,
          "properties": {
            "category": {
              "enum": [
                "syntax",
                "quoting",
                "shell_incompatible",
                "executable_unavailable",
                "wrong_working_directory",
                "path_not_found",
                "argument_incompatible",
                "dependency_missing",
                "configuration_missing",
                "environment_invalid",
                "permission_denied",
                "confirmation_required",
                "resource_locked",
                "transient_failure",
                "timeout",
                "cancelled",
                "build_failed",
                "test_failed",
                "application_failed",
                "authentication_failed",
                "authorization_failed",
                "partial_completion_possible",
                "outcome_unknown",
                "unclassified"
              ],
              "type": "string"
            },
            "confidence": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "message": {
              "maxLength": 1000,
              "minLength": 1,
              "type": "string"
            },
            "source": {
              "enum": [
                "deterministic",
                "provider"
              ],
              "type": "string"
            }
          },
          "required": [
            "category",
            "confidence",
            "source"
          ],
          "type": "object"
        },
        "executionMode": {
          "enum": [
            "direct",
            "qualified"
          ],
          "type": "string"
        },
        "exitCode": {
          "anyOf": [
            {
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer"
            },
            {
              "type": "null"
            }
          ]
        },
        "expiresAt": {
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
          "type": "string"
        },
        "lifecycle": {
          "additionalProperties": false,
          "properties": {
            "deadlineAt": {
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
              "type": "string"
            },
            "diagnostic": {
              "maxLength": 500,
              "minLength": 1,
              "type": "string"
            },
            "effectiveTimeoutMs": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer"
            },
            "elapsedMs": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer"
            },
            "reason": {
              "enum": [
                "timeout",
                "cancelled",
                "client_disconnected",
                "upstream_timeout",
                "process_failed"
              ],
              "type": "string"
            },
            "requestedTimeoutMs": {
              "exclusiveMinimum": 0,
              "maximum": 86400000,
              "type": "integer"
            },
            "terminatedBy": {
              "enum": [
                "chatgpt_tool",
                "mcp_server",
                "gateway",
                "relay",
                "workspace_agent",
                "executor",
                "child_process",
                "http_client",
                "http_server",
                "websocket",
                "proxy",
                "background_task_manager",
                "external"
              ],
              "type": "string"
            }
          },
          "required": [
            "requestedTimeoutMs",
            "effectiveTimeoutMs",
            "deadlineAt",
            "elapsedMs"
          ],
          "type": "object"
        },
        "postcondition": {
          "additionalProperties": false,
          "properties": {
            "checked": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer"
            },
            "failed": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer"
            },
            "passed": {
              "type": "boolean"
            }
          },
          "required": [
            "passed",
            "checked",
            "failed"
          ],
          "type": "object"
        },
        "reasons": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        },
        "shell": {
          "enum": [
            "powershell",
            "pwsh",
            "cmd",
            "wsl",
            "git-bash"
          ],
          "type": "string"
        },
        "status": {
          "enum": [
            "executed",
            "confirmation_required",
            "background_task_started"
          ],
          "type": "string"
        },
        "stderr": {
          "type": "string"
        },
        "stdout": {
          "type": "string"
        },
        "task": {
          "additionalProperties": false,
          "properties": {
            "command": {
              "maxLength": 32000,
              "minLength": 1,
              "type": "string"
            },
            "commandHash": {
              "pattern": "^[a-f0-9]{64}$",
              "type": "string"
            },
            "completedAt": {
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
              "type": "string"
            },
            "createdAt": {
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
              "type": "string"
            },
            "cwd": {
              "minLength": 1,
              "type": "string"
            },
            "error": {
              "type": "string"
            },
            "id": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
              "type": "string"
            },
            "lifecycle": {
              "additionalProperties": false,
              "properties": {
                "deadlineAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "diagnostic": {
                  "maxLength": 500,
                  "minLength": 1,
                  "type": "string"
                },
                "effectiveTimeoutMs": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "elapsedMs": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "reason": {
                  "enum": [
                    "timeout",
                    "cancelled",
                    "client_disconnected",
                    "upstream_timeout",
                    "process_failed"
                  ],
                  "type": "string"
                },
                "requestedTimeoutMs": {
                  "exclusiveMinimum": 0,
                  "maximum": 86400000,
                  "type": "integer"
                },
                "terminatedBy": {
                  "enum": [
                    "chatgpt_tool",
                    "mcp_server",
                    "gateway",
                    "relay",
                    "workspace_agent",
                    "executor",
                    "child_process",
                    "http_client",
                    "http_server",
                    "websocket",
                    "proxy",
                    "background_task_manager",
                    "external"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "requestedTimeoutMs",
                "effectiveTimeoutMs",
                "deadlineAt",
                "elapsedMs"
              ],
              "type": "object"
            },
            "operation": {
              "maxLength": 128,
              "minLength": 1,
              "type": "string"
            },
            "pid": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            },
            "result": {
              "additionalProperties": false,
              "properties": {
                "cwd": {
                  "type": "string"
                },
                "exitCode": {
                  "anyOf": [
                    {
                      "maximum": 9007199254740991,
                      "minimum": -9007199254740991,
                      "type": "integer"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "lifecycle": {
                  "additionalProperties": false,
                  "properties": {
                    "deadlineAt": {
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                      "type": "string"
                    },
                    "diagnostic": {
                      "maxLength": 500,
                      "minLength": 1,
                      "type": "string"
                    },
                    "effectiveTimeoutMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "elapsedMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "reason": {
                      "enum": [
                        "timeout",
                        "cancelled",
                        "client_disconnected",
                        "upstream_timeout",
                        "process_failed"
                      ],
                      "type": "string"
                    },
                    "requestedTimeoutMs": {
                      "exclusiveMinimum": 0,
                      "maximum": 86400000,
                      "type": "integer"
                    },
                    "terminatedBy": {
                      "enum": [
                        "chatgpt_tool",
                        "mcp_server",
                        "gateway",
                        "relay",
                        "workspace_agent",
                        "executor",
                        "child_process",
                        "http_client",
                        "http_server",
                        "websocket",
                        "proxy",
                        "background_task_manager",
                        "external"
                      ],
                      "type": "string"
                    }
                  },
                  "required": [
                    "requestedTimeoutMs",
                    "effectiveTimeoutMs",
                    "deadlineAt",
                    "elapsedMs"
                  ],
                  "type": "object"
                },
                "shell": {
                  "enum": [
                    "powershell",
                    "pwsh",
                    "cmd",
                    "wsl",
                    "git-bash"
                  ],
                  "type": "string"
                },
                "status": {
                  "const": "executed",
                  "type": "string"
                },
                "stderr": {
                  "type": "string"
                },
                "stdout": {
                  "type": "string"
                },
                "timedOut": {
                  "type": "boolean"
                }
              },
              "required": [
                "status",
                "shell",
                "cwd",
                "exitCode",
                "stdout",
                "stderr",
                "timedOut"
              ],
              "type": "object"
            },
            "shell": {
              "enum": [
                "powershell",
                "pwsh",
                "cmd",
                "wsl",
                "git-bash"
              ],
              "type": "string"
            },
            "startedAt": {
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
              "type": "string"
            },
            "state": {
              "enum": [
                "starting",
                "running",
                "succeeded",
                "failed",
                "cancelled"
              ],
              "type": "string"
            },
            "timeoutMs": {
              "maximum": 86400000,
              "minimum": 30000,
              "type": "integer"
            },
            "version": {
              "const": 1,
              "type": "number"
            },
            "workspaceId": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "version",
            "id",
            "workspaceId",
            "operation",
            "commandHash",
            "command",
            "shell",
            "cwd",
            "state",
            "createdAt",
            "timeoutMs"
          ],
          "type": "object"
        },
        "timedOut": {
          "type": "boolean"
        }
      },
      "required": [
        "status"
      ],
      "type": "object"
    },
    "title": "Run command"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Compatibility shortcut for direct PowerShell-only execution with the workspace root as working directory. For new routing decisions prefer run_command, including for PowerShell, when its shell selection, qualified execution, autocorrection or expectedOutcome features are useful. Use this tool when the caller specifically needs the simpler PowerShell-only contract. Requires allowShell in workspace policy.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "command": {
          "maxLength": 32000,
          "minLength": 1,
          "type": "string"
        },
        "confirmationId": {
          "maxLength": 128,
          "minLength": 1,
          "type": "string"
        },
        "cwd": {
          "minLength": 1,
          "type": "string"
        },
        "timeoutMs": {
          "default": 60000,
          "exclusiveMinimum": 0,
          "maximum": 86400000,
          "type": "integer"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "command"
      ],
      "type": "object"
    },
    "name": "run_powershell",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "attemptCount": {
          "maximum": 2,
          "minimum": 1,
          "type": "integer"
        },
        "attempts": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "attempt": {
                "maximum": 2,
                "minimum": 1,
                "type": "integer"
              },
              "completedAt": {
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                "type": "string"
              },
              "cwd": {
                "minLength": 1,
                "type": "string"
              },
              "exitCode": {
                "anyOf": [
                  {
                    "maximum": 9007199254740991,
                    "minimum": -9007199254740991,
                    "type": "integer"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "planFingerprint": {
                "pattern": "^[a-f0-9]{64}$",
                "type": "string"
              },
              "shell": {
                "enum": [
                  "powershell",
                  "pwsh",
                  "cmd",
                  "wsl",
                  "git-bash"
                ],
                "type": "string"
              },
              "startedAt": {
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                "type": "string"
              },
              "timedOut": {
                "type": "boolean"
              }
            },
            "required": [
              "attempt",
              "planFingerprint",
              "shell",
              "cwd",
              "exitCode",
              "timedOut",
              "startedAt",
              "completedAt"
            ],
            "type": "object"
          },
          "maxItems": 2,
          "type": "array"
        },
        "confirmationId": {
          "type": "string"
        },
        "corrected": {
          "type": "boolean"
        },
        "correction": {
          "additionalProperties": false,
          "properties": {
            "applied": {
              "type": "boolean"
            },
            "blockedReason": {
              "maxLength": 1000,
              "minLength": 1,
              "type": "string"
            },
            "effectiveCommand": {
              "maxLength": 32000,
              "minLength": 1,
              "type": "string"
            },
            "effectiveCwd": {
              "maxLength": 4096,
              "minLength": 1,
              "type": "string"
            },
            "effectiveShell": {
              "enum": [
                "powershell",
                "pwsh",
                "cmd",
                "wsl",
                "git-bash"
              ],
              "type": "string"
            },
            "sanitized": {
              "type": "boolean"
            }
          },
          "required": [
            "applied",
            "sanitized"
          ],
          "type": "object"
        },
        "cwd": {
          "type": "string"
        },
        "diagnosis": {
          "additionalProperties": false,
          "properties": {
            "category": {
              "enum": [
                "syntax",
                "quoting",
                "shell_incompatible",
                "executable_unavailable",
                "wrong_working_directory",
                "path_not_found",
                "argument_incompatible",
                "dependency_missing",
                "configuration_missing",
                "environment_invalid",
                "permission_denied",
                "confirmation_required",
                "resource_locked",
                "transient_failure",
                "timeout",
                "cancelled",
                "build_failed",
                "test_failed",
                "application_failed",
                "authentication_failed",
                "authorization_failed",
                "partial_completion_possible",
                "outcome_unknown",
                "unclassified"
              ],
              "type": "string"
            },
            "confidence": {
              "maximum": 1,
              "minimum": 0,
              "type": "number"
            },
            "message": {
              "maxLength": 1000,
              "minLength": 1,
              "type": "string"
            },
            "source": {
              "enum": [
                "deterministic",
                "provider"
              ],
              "type": "string"
            }
          },
          "required": [
            "category",
            "confidence",
            "source"
          ],
          "type": "object"
        },
        "executionMode": {
          "enum": [
            "direct",
            "qualified"
          ],
          "type": "string"
        },
        "exitCode": {
          "anyOf": [
            {
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer"
            },
            {
              "type": "null"
            }
          ]
        },
        "expiresAt": {
          "format": "date-time",
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
          "type": "string"
        },
        "lifecycle": {
          "additionalProperties": false,
          "properties": {
            "deadlineAt": {
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
              "type": "string"
            },
            "diagnostic": {
              "maxLength": 500,
              "minLength": 1,
              "type": "string"
            },
            "effectiveTimeoutMs": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer"
            },
            "elapsedMs": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer"
            },
            "reason": {
              "enum": [
                "timeout",
                "cancelled",
                "client_disconnected",
                "upstream_timeout",
                "process_failed"
              ],
              "type": "string"
            },
            "requestedTimeoutMs": {
              "exclusiveMinimum": 0,
              "maximum": 86400000,
              "type": "integer"
            },
            "terminatedBy": {
              "enum": [
                "chatgpt_tool",
                "mcp_server",
                "gateway",
                "relay",
                "workspace_agent",
                "executor",
                "child_process",
                "http_client",
                "http_server",
                "websocket",
                "proxy",
                "background_task_manager",
                "external"
              ],
              "type": "string"
            }
          },
          "required": [
            "requestedTimeoutMs",
            "effectiveTimeoutMs",
            "deadlineAt",
            "elapsedMs"
          ],
          "type": "object"
        },
        "postcondition": {
          "additionalProperties": false,
          "properties": {
            "checked": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer"
            },
            "failed": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer"
            },
            "passed": {
              "type": "boolean"
            }
          },
          "required": [
            "passed",
            "checked",
            "failed"
          ],
          "type": "object"
        },
        "reasons": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        },
        "shell": {
          "enum": [
            "powershell",
            "pwsh",
            "cmd",
            "wsl",
            "git-bash"
          ],
          "type": "string"
        },
        "status": {
          "enum": [
            "executed",
            "confirmation_required",
            "background_task_started"
          ],
          "type": "string"
        },
        "stderr": {
          "type": "string"
        },
        "stdout": {
          "type": "string"
        },
        "task": {
          "additionalProperties": false,
          "properties": {
            "command": {
              "maxLength": 32000,
              "minLength": 1,
              "type": "string"
            },
            "commandHash": {
              "pattern": "^[a-f0-9]{64}$",
              "type": "string"
            },
            "completedAt": {
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
              "type": "string"
            },
            "createdAt": {
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
              "type": "string"
            },
            "cwd": {
              "minLength": 1,
              "type": "string"
            },
            "error": {
              "type": "string"
            },
            "id": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
              "type": "string"
            },
            "lifecycle": {
              "additionalProperties": false,
              "properties": {
                "deadlineAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "diagnostic": {
                  "maxLength": 500,
                  "minLength": 1,
                  "type": "string"
                },
                "effectiveTimeoutMs": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "elapsedMs": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "reason": {
                  "enum": [
                    "timeout",
                    "cancelled",
                    "client_disconnected",
                    "upstream_timeout",
                    "process_failed"
                  ],
                  "type": "string"
                },
                "requestedTimeoutMs": {
                  "exclusiveMinimum": 0,
                  "maximum": 86400000,
                  "type": "integer"
                },
                "terminatedBy": {
                  "enum": [
                    "chatgpt_tool",
                    "mcp_server",
                    "gateway",
                    "relay",
                    "workspace_agent",
                    "executor",
                    "child_process",
                    "http_client",
                    "http_server",
                    "websocket",
                    "proxy",
                    "background_task_manager",
                    "external"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "requestedTimeoutMs",
                "effectiveTimeoutMs",
                "deadlineAt",
                "elapsedMs"
              ],
              "type": "object"
            },
            "operation": {
              "maxLength": 128,
              "minLength": 1,
              "type": "string"
            },
            "pid": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            },
            "result": {
              "additionalProperties": false,
              "properties": {
                "cwd": {
                  "type": "string"
                },
                "exitCode": {
                  "anyOf": [
                    {
                      "maximum": 9007199254740991,
                      "minimum": -9007199254740991,
                      "type": "integer"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "lifecycle": {
                  "additionalProperties": false,
                  "properties": {
                    "deadlineAt": {
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                      "type": "string"
                    },
                    "diagnostic": {
                      "maxLength": 500,
                      "minLength": 1,
                      "type": "string"
                    },
                    "effectiveTimeoutMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "elapsedMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "reason": {
                      "enum": [
                        "timeout",
                        "cancelled",
                        "client_disconnected",
                        "upstream_timeout",
                        "process_failed"
                      ],
                      "type": "string"
                    },
                    "requestedTimeoutMs": {
                      "exclusiveMinimum": 0,
                      "maximum": 86400000,
                      "type": "integer"
                    },
                    "terminatedBy": {
                      "enum": [
                        "chatgpt_tool",
                        "mcp_server",
                        "gateway",
                        "relay",
                        "workspace_agent",
                        "executor",
                        "child_process",
                        "http_client",
                        "http_server",
                        "websocket",
                        "proxy",
                        "background_task_manager",
                        "external"
                      ],
                      "type": "string"
                    }
                  },
                  "required": [
                    "requestedTimeoutMs",
                    "effectiveTimeoutMs",
                    "deadlineAt",
                    "elapsedMs"
                  ],
                  "type": "object"
                },
                "shell": {
                  "enum": [
                    "powershell",
                    "pwsh",
                    "cmd",
                    "wsl",
                    "git-bash"
                  ],
                  "type": "string"
                },
                "status": {
                  "const": "executed",
                  "type": "string"
                },
                "stderr": {
                  "type": "string"
                },
                "stdout": {
                  "type": "string"
                },
                "timedOut": {
                  "type": "boolean"
                }
              },
              "required": [
                "status",
                "shell",
                "cwd",
                "exitCode",
                "stdout",
                "stderr",
                "timedOut"
              ],
              "type": "object"
            },
            "shell": {
              "enum": [
                "powershell",
                "pwsh",
                "cmd",
                "wsl",
                "git-bash"
              ],
              "type": "string"
            },
            "startedAt": {
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
              "type": "string"
            },
            "state": {
              "enum": [
                "starting",
                "running",
                "succeeded",
                "failed",
                "cancelled"
              ],
              "type": "string"
            },
            "timeoutMs": {
              "maximum": 86400000,
              "minimum": 30000,
              "type": "integer"
            },
            "version": {
              "const": 1,
              "type": "number"
            },
            "workspaceId": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "version",
            "id",
            "workspaceId",
            "operation",
            "commandHash",
            "command",
            "shell",
            "cwd",
            "state",
            "createdAt",
            "timeoutMs"
          ],
          "type": "object"
        },
        "timedOut": {
          "type": "boolean"
        }
      },
      "required": [
        "status"
      ],
      "type": "object"
    },
    "title": "Run PowerShell"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Starts a long-running command in an authorized workspace. Active duplicate commands are deduplicated and return the existing task.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "command": {
          "maxLength": 32000,
          "minLength": 1,
          "type": "string"
        },
        "cwd": {
          "minLength": 1,
          "type": "string"
        },
        "operation": {
          "maxLength": 128,
          "minLength": 1,
          "type": "string"
        },
        "shell": {
          "enum": [
            "powershell",
            "pwsh",
            "cmd",
            "wsl",
            "git-bash"
          ],
          "type": "string"
        },
        "timeoutMs": {
          "default": 120000,
          "maximum": 86400000,
          "minimum": 30000,
          "type": "integer"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "operation",
        "command",
        "shell"
      ],
      "type": "object"
    },
    "name": "start_background_task",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "task": {
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "command": {
                  "maxLength": 32000,
                  "minLength": 1,
                  "type": "string"
                },
                "commandHash": {
                  "pattern": "^[a-f0-9]{64}$",
                  "type": "string"
                },
                "completedAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "createdAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "cwd": {
                  "minLength": 1,
                  "type": "string"
                },
                "error": {
                  "type": "string"
                },
                "id": {
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                  "type": "string"
                },
                "lifecycle": {
                  "additionalProperties": false,
                  "properties": {
                    "deadlineAt": {
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                      "type": "string"
                    },
                    "diagnostic": {
                      "maxLength": 500,
                      "minLength": 1,
                      "type": "string"
                    },
                    "effectiveTimeoutMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "elapsedMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "reason": {
                      "enum": [
                        "timeout",
                        "cancelled",
                        "client_disconnected",
                        "upstream_timeout",
                        "process_failed"
                      ],
                      "type": "string"
                    },
                    "requestedTimeoutMs": {
                      "exclusiveMinimum": 0,
                      "maximum": 86400000,
                      "type": "integer"
                    },
                    "terminatedBy": {
                      "enum": [
                        "chatgpt_tool",
                        "mcp_server",
                        "gateway",
                        "relay",
                        "workspace_agent",
                        "executor",
                        "child_process",
                        "http_client",
                        "http_server",
                        "websocket",
                        "proxy",
                        "background_task_manager",
                        "external"
                      ],
                      "type": "string"
                    }
                  },
                  "required": [
                    "requestedTimeoutMs",
                    "effectiveTimeoutMs",
                    "deadlineAt",
                    "elapsedMs"
                  ],
                  "type": "object"
                },
                "operation": {
                  "maxLength": 128,
                  "minLength": 1,
                  "type": "string"
                },
                "pid": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "result": {
                  "additionalProperties": false,
                  "properties": {
                    "cwd": {
                      "type": "string"
                    },
                    "exitCode": {
                      "anyOf": [
                        {
                          "maximum": 9007199254740991,
                          "minimum": -9007199254740991,
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "lifecycle": {
                      "additionalProperties": false,
                      "properties": {
                        "deadlineAt": {
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                          "type": "string"
                        },
                        "diagnostic": {
                          "maxLength": 500,
                          "minLength": 1,
                          "type": "string"
                        },
                        "effectiveTimeoutMs": {
                          "maximum": 9007199254740991,
                          "minimum": 0,
                          "type": "integer"
                        },
                        "elapsedMs": {
                          "maximum": 9007199254740991,
                          "minimum": 0,
                          "type": "integer"
                        },
                        "reason": {
                          "enum": [
                            "timeout",
                            "cancelled",
                            "client_disconnected",
                            "upstream_timeout",
                            "process_failed"
                          ],
                          "type": "string"
                        },
                        "requestedTimeoutMs": {
                          "exclusiveMinimum": 0,
                          "maximum": 86400000,
                          "type": "integer"
                        },
                        "terminatedBy": {
                          "enum": [
                            "chatgpt_tool",
                            "mcp_server",
                            "gateway",
                            "relay",
                            "workspace_agent",
                            "executor",
                            "child_process",
                            "http_client",
                            "http_server",
                            "websocket",
                            "proxy",
                            "background_task_manager",
                            "external"
                          ],
                          "type": "string"
                        }
                      },
                      "required": [
                        "requestedTimeoutMs",
                        "effectiveTimeoutMs",
                        "deadlineAt",
                        "elapsedMs"
                      ],
                      "type": "object"
                    },
                    "shell": {
                      "enum": [
                        "powershell",
                        "pwsh",
                        "cmd",
                        "wsl",
                        "git-bash"
                      ],
                      "type": "string"
                    },
                    "status": {
                      "const": "executed",
                      "type": "string"
                    },
                    "stderr": {
                      "type": "string"
                    },
                    "stdout": {
                      "type": "string"
                    },
                    "timedOut": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "status",
                    "shell",
                    "cwd",
                    "exitCode",
                    "stdout",
                    "stderr",
                    "timedOut"
                  ],
                  "type": "object"
                },
                "shell": {
                  "enum": [
                    "powershell",
                    "pwsh",
                    "cmd",
                    "wsl",
                    "git-bash"
                  ],
                  "type": "string"
                },
                "startedAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "state": {
                  "enum": [
                    "starting",
                    "running",
                    "succeeded",
                    "failed",
                    "cancelled"
                  ],
                  "type": "string"
                },
                "timeoutMs": {
                  "maximum": 86400000,
                  "minimum": 30000,
                  "type": "integer"
                },
                "version": {
                  "const": 1,
                  "type": "number"
                },
                "workspaceId": {
                  "minLength": 1,
                  "type": "string"
                }
              },
              "required": [
                "version",
                "id",
                "workspaceId",
                "operation",
                "commandHash",
                "command",
                "shell",
                "cwd",
                "state",
                "createdAt",
                "timeoutMs"
              ],
              "type": "object"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "task"
      ],
      "type": "object"
    },
    "title": "Start background task"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Returns the persisted state and result of one background task.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "id": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "id"
      ],
      "type": "object"
    },
    "name": "get_background_task",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "task": {
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "command": {
                  "maxLength": 32000,
                  "minLength": 1,
                  "type": "string"
                },
                "commandHash": {
                  "pattern": "^[a-f0-9]{64}$",
                  "type": "string"
                },
                "completedAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "createdAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "cwd": {
                  "minLength": 1,
                  "type": "string"
                },
                "error": {
                  "type": "string"
                },
                "id": {
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                  "type": "string"
                },
                "lifecycle": {
                  "additionalProperties": false,
                  "properties": {
                    "deadlineAt": {
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                      "type": "string"
                    },
                    "diagnostic": {
                      "maxLength": 500,
                      "minLength": 1,
                      "type": "string"
                    },
                    "effectiveTimeoutMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "elapsedMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "reason": {
                      "enum": [
                        "timeout",
                        "cancelled",
                        "client_disconnected",
                        "upstream_timeout",
                        "process_failed"
                      ],
                      "type": "string"
                    },
                    "requestedTimeoutMs": {
                      "exclusiveMinimum": 0,
                      "maximum": 86400000,
                      "type": "integer"
                    },
                    "terminatedBy": {
                      "enum": [
                        "chatgpt_tool",
                        "mcp_server",
                        "gateway",
                        "relay",
                        "workspace_agent",
                        "executor",
                        "child_process",
                        "http_client",
                        "http_server",
                        "websocket",
                        "proxy",
                        "background_task_manager",
                        "external"
                      ],
                      "type": "string"
                    }
                  },
                  "required": [
                    "requestedTimeoutMs",
                    "effectiveTimeoutMs",
                    "deadlineAt",
                    "elapsedMs"
                  ],
                  "type": "object"
                },
                "operation": {
                  "maxLength": 128,
                  "minLength": 1,
                  "type": "string"
                },
                "pid": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "result": {
                  "additionalProperties": false,
                  "properties": {
                    "cwd": {
                      "type": "string"
                    },
                    "exitCode": {
                      "anyOf": [
                        {
                          "maximum": 9007199254740991,
                          "minimum": -9007199254740991,
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "lifecycle": {
                      "additionalProperties": false,
                      "properties": {
                        "deadlineAt": {
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                          "type": "string"
                        },
                        "diagnostic": {
                          "maxLength": 500,
                          "minLength": 1,
                          "type": "string"
                        },
                        "effectiveTimeoutMs": {
                          "maximum": 9007199254740991,
                          "minimum": 0,
                          "type": "integer"
                        },
                        "elapsedMs": {
                          "maximum": 9007199254740991,
                          "minimum": 0,
                          "type": "integer"
                        },
                        "reason": {
                          "enum": [
                            "timeout",
                            "cancelled",
                            "client_disconnected",
                            "upstream_timeout",
                            "process_failed"
                          ],
                          "type": "string"
                        },
                        "requestedTimeoutMs": {
                          "exclusiveMinimum": 0,
                          "maximum": 86400000,
                          "type": "integer"
                        },
                        "terminatedBy": {
                          "enum": [
                            "chatgpt_tool",
                            "mcp_server",
                            "gateway",
                            "relay",
                            "workspace_agent",
                            "executor",
                            "child_process",
                            "http_client",
                            "http_server",
                            "websocket",
                            "proxy",
                            "background_task_manager",
                            "external"
                          ],
                          "type": "string"
                        }
                      },
                      "required": [
                        "requestedTimeoutMs",
                        "effectiveTimeoutMs",
                        "deadlineAt",
                        "elapsedMs"
                      ],
                      "type": "object"
                    },
                    "shell": {
                      "enum": [
                        "powershell",
                        "pwsh",
                        "cmd",
                        "wsl",
                        "git-bash"
                      ],
                      "type": "string"
                    },
                    "status": {
                      "const": "executed",
                      "type": "string"
                    },
                    "stderr": {
                      "type": "string"
                    },
                    "stdout": {
                      "type": "string"
                    },
                    "timedOut": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "status",
                    "shell",
                    "cwd",
                    "exitCode",
                    "stdout",
                    "stderr",
                    "timedOut"
                  ],
                  "type": "object"
                },
                "shell": {
                  "enum": [
                    "powershell",
                    "pwsh",
                    "cmd",
                    "wsl",
                    "git-bash"
                  ],
                  "type": "string"
                },
                "startedAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "state": {
                  "enum": [
                    "starting",
                    "running",
                    "succeeded",
                    "failed",
                    "cancelled"
                  ],
                  "type": "string"
                },
                "timeoutMs": {
                  "maximum": 86400000,
                  "minimum": 30000,
                  "type": "integer"
                },
                "version": {
                  "const": 1,
                  "type": "number"
                },
                "workspaceId": {
                  "minLength": 1,
                  "type": "string"
                }
              },
              "required": [
                "version",
                "id",
                "workspaceId",
                "operation",
                "commandHash",
                "command",
                "shell",
                "cwd",
                "state",
                "createdAt",
                "timeoutMs"
              ],
              "type": "object"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "task"
      ],
      "type": "object"
    },
    "title": "Get background task"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Waits up to timeoutMs for one persisted background task to reach a terminal state. A wait timeout stops waiting only and never cancels the task. Returns the current/terminal task plus size-limited redacted stdout/stderr tails.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "id": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "maxBytes": {
          "default": 100000,
          "exclusiveMinimum": 0,
          "maximum": 1000000,
          "type": "integer"
        },
        "timeoutMs": {
          "default": 60000,
          "exclusiveMinimum": 0,
          "maximum": 300000,
          "type": "integer"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "id"
      ],
      "type": "object"
    },
    "name": "wait_background_task",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "elapsedMs": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "logs": {
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "id": {
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                  "type": "string"
                },
                "stderr": {
                  "type": "string"
                },
                "stderrBytes": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "stdout": {
                  "type": "string"
                },
                "stdoutBytes": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "truncated": {
                  "type": "boolean"
                }
              },
              "required": [
                "id",
                "stdout",
                "stderr",
                "stdoutBytes",
                "stderrBytes",
                "truncated"
              ],
              "type": "object"
            },
            {
              "type": "null"
            }
          ]
        },
        "task": {
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "command": {
                  "maxLength": 32000,
                  "minLength": 1,
                  "type": "string"
                },
                "commandHash": {
                  "pattern": "^[a-f0-9]{64}$",
                  "type": "string"
                },
                "completedAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "createdAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "cwd": {
                  "minLength": 1,
                  "type": "string"
                },
                "error": {
                  "type": "string"
                },
                "id": {
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                  "type": "string"
                },
                "lifecycle": {
                  "additionalProperties": false,
                  "properties": {
                    "deadlineAt": {
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                      "type": "string"
                    },
                    "diagnostic": {
                      "maxLength": 500,
                      "minLength": 1,
                      "type": "string"
                    },
                    "effectiveTimeoutMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "elapsedMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "reason": {
                      "enum": [
                        "timeout",
                        "cancelled",
                        "client_disconnected",
                        "upstream_timeout",
                        "process_failed"
                      ],
                      "type": "string"
                    },
                    "requestedTimeoutMs": {
                      "exclusiveMinimum": 0,
                      "maximum": 86400000,
                      "type": "integer"
                    },
                    "terminatedBy": {
                      "enum": [
                        "chatgpt_tool",
                        "mcp_server",
                        "gateway",
                        "relay",
                        "workspace_agent",
                        "executor",
                        "child_process",
                        "http_client",
                        "http_server",
                        "websocket",
                        "proxy",
                        "background_task_manager",
                        "external"
                      ],
                      "type": "string"
                    }
                  },
                  "required": [
                    "requestedTimeoutMs",
                    "effectiveTimeoutMs",
                    "deadlineAt",
                    "elapsedMs"
                  ],
                  "type": "object"
                },
                "operation": {
                  "maxLength": 128,
                  "minLength": 1,
                  "type": "string"
                },
                "pid": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "result": {
                  "additionalProperties": false,
                  "properties": {
                    "cwd": {
                      "type": "string"
                    },
                    "exitCode": {
                      "anyOf": [
                        {
                          "maximum": 9007199254740991,
                          "minimum": -9007199254740991,
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "lifecycle": {
                      "additionalProperties": false,
                      "properties": {
                        "deadlineAt": {
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                          "type": "string"
                        },
                        "diagnostic": {
                          "maxLength": 500,
                          "minLength": 1,
                          "type": "string"
                        },
                        "effectiveTimeoutMs": {
                          "maximum": 9007199254740991,
                          "minimum": 0,
                          "type": "integer"
                        },
                        "elapsedMs": {
                          "maximum": 9007199254740991,
                          "minimum": 0,
                          "type": "integer"
                        },
                        "reason": {
                          "enum": [
                            "timeout",
                            "cancelled",
                            "client_disconnected",
                            "upstream_timeout",
                            "process_failed"
                          ],
                          "type": "string"
                        },
                        "requestedTimeoutMs": {
                          "exclusiveMinimum": 0,
                          "maximum": 86400000,
                          "type": "integer"
                        },
                        "terminatedBy": {
                          "enum": [
                            "chatgpt_tool",
                            "mcp_server",
                            "gateway",
                            "relay",
                            "workspace_agent",
                            "executor",
                            "child_process",
                            "http_client",
                            "http_server",
                            "websocket",
                            "proxy",
                            "background_task_manager",
                            "external"
                          ],
                          "type": "string"
                        }
                      },
                      "required": [
                        "requestedTimeoutMs",
                        "effectiveTimeoutMs",
                        "deadlineAt",
                        "elapsedMs"
                      ],
                      "type": "object"
                    },
                    "shell": {
                      "enum": [
                        "powershell",
                        "pwsh",
                        "cmd",
                        "wsl",
                        "git-bash"
                      ],
                      "type": "string"
                    },
                    "status": {
                      "const": "executed",
                      "type": "string"
                    },
                    "stderr": {
                      "type": "string"
                    },
                    "stdout": {
                      "type": "string"
                    },
                    "timedOut": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "status",
                    "shell",
                    "cwd",
                    "exitCode",
                    "stdout",
                    "stderr",
                    "timedOut"
                  ],
                  "type": "object"
                },
                "shell": {
                  "enum": [
                    "powershell",
                    "pwsh",
                    "cmd",
                    "wsl",
                    "git-bash"
                  ],
                  "type": "string"
                },
                "startedAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "state": {
                  "enum": [
                    "starting",
                    "running",
                    "succeeded",
                    "failed",
                    "cancelled"
                  ],
                  "type": "string"
                },
                "timeoutMs": {
                  "maximum": 86400000,
                  "minimum": 30000,
                  "type": "integer"
                },
                "version": {
                  "const": 1,
                  "type": "number"
                },
                "workspaceId": {
                  "minLength": 1,
                  "type": "string"
                }
              },
              "required": [
                "version",
                "id",
                "workspaceId",
                "operation",
                "commandHash",
                "command",
                "shell",
                "cwd",
                "state",
                "createdAt",
                "timeoutMs"
              ],
              "type": "object"
            },
            {
              "type": "null"
            }
          ]
        },
        "timedOut": {
          "type": "boolean"
        }
      },
      "required": [
        "task",
        "logs",
        "timedOut",
        "elapsedMs"
      ],
      "type": "object"
    },
    "title": "Wait for background task"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Lists persisted background tasks for one authorized workspace.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "state": {
          "enum": [
            "starting",
            "running",
            "succeeded",
            "failed",
            "cancelled"
          ],
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "type": "object"
    },
    "name": "list_background_tasks",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "tasks": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "command": {
                "maxLength": 32000,
                "minLength": 1,
                "type": "string"
              },
              "commandHash": {
                "pattern": "^[a-f0-9]{64}$",
                "type": "string"
              },
              "completedAt": {
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                "type": "string"
              },
              "createdAt": {
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                "type": "string"
              },
              "cwd": {
                "minLength": 1,
                "type": "string"
              },
              "error": {
                "type": "string"
              },
              "id": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                "type": "string"
              },
              "lifecycle": {
                "additionalProperties": false,
                "properties": {
                  "deadlineAt": {
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                    "type": "string"
                  },
                  "diagnostic": {
                    "maxLength": 500,
                    "minLength": 1,
                    "type": "string"
                  },
                  "effectiveTimeoutMs": {
                    "maximum": 9007199254740991,
                    "minimum": 0,
                    "type": "integer"
                  },
                  "elapsedMs": {
                    "maximum": 9007199254740991,
                    "minimum": 0,
                    "type": "integer"
                  },
                  "reason": {
                    "enum": [
                      "timeout",
                      "cancelled",
                      "client_disconnected",
                      "upstream_timeout",
                      "process_failed"
                    ],
                    "type": "string"
                  },
                  "requestedTimeoutMs": {
                    "exclusiveMinimum": 0,
                    "maximum": 86400000,
                    "type": "integer"
                  },
                  "terminatedBy": {
                    "enum": [
                      "chatgpt_tool",
                      "mcp_server",
                      "gateway",
                      "relay",
                      "workspace_agent",
                      "executor",
                      "child_process",
                      "http_client",
                      "http_server",
                      "websocket",
                      "proxy",
                      "background_task_manager",
                      "external"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "requestedTimeoutMs",
                  "effectiveTimeoutMs",
                  "deadlineAt",
                  "elapsedMs"
                ],
                "type": "object"
              },
              "operation": {
                "maxLength": 128,
                "minLength": 1,
                "type": "string"
              },
              "pid": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              },
              "result": {
                "additionalProperties": false,
                "properties": {
                  "cwd": {
                    "type": "string"
                  },
                  "exitCode": {
                    "anyOf": [
                      {
                        "maximum": 9007199254740991,
                        "minimum": -9007199254740991,
                        "type": "integer"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "lifecycle": {
                    "additionalProperties": false,
                    "properties": {
                      "deadlineAt": {
                        "format": "date-time",
                        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                        "type": "string"
                      },
                      "diagnostic": {
                        "maxLength": 500,
                        "minLength": 1,
                        "type": "string"
                      },
                      "effectiveTimeoutMs": {
                        "maximum": 9007199254740991,
                        "minimum": 0,
                        "type": "integer"
                      },
                      "elapsedMs": {
                        "maximum": 9007199254740991,
                        "minimum": 0,
                        "type": "integer"
                      },
                      "reason": {
                        "enum": [
                          "timeout",
                          "cancelled",
                          "client_disconnected",
                          "upstream_timeout",
                          "process_failed"
                        ],
                        "type": "string"
                      },
                      "requestedTimeoutMs": {
                        "exclusiveMinimum": 0,
                        "maximum": 86400000,
                        "type": "integer"
                      },
                      "terminatedBy": {
                        "enum": [
                          "chatgpt_tool",
                          "mcp_server",
                          "gateway",
                          "relay",
                          "workspace_agent",
                          "executor",
                          "child_process",
                          "http_client",
                          "http_server",
                          "websocket",
                          "proxy",
                          "background_task_manager",
                          "external"
                        ],
                        "type": "string"
                      }
                    },
                    "required": [
                      "requestedTimeoutMs",
                      "effectiveTimeoutMs",
                      "deadlineAt",
                      "elapsedMs"
                    ],
                    "type": "object"
                  },
                  "shell": {
                    "enum": [
                      "powershell",
                      "pwsh",
                      "cmd",
                      "wsl",
                      "git-bash"
                    ],
                    "type": "string"
                  },
                  "status": {
                    "const": "executed",
                    "type": "string"
                  },
                  "stderr": {
                    "type": "string"
                  },
                  "stdout": {
                    "type": "string"
                  },
                  "timedOut": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "status",
                  "shell",
                  "cwd",
                  "exitCode",
                  "stdout",
                  "stderr",
                  "timedOut"
                ],
                "type": "object"
              },
              "shell": {
                "enum": [
                  "powershell",
                  "pwsh",
                  "cmd",
                  "wsl",
                  "git-bash"
                ],
                "type": "string"
              },
              "startedAt": {
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                "type": "string"
              },
              "state": {
                "enum": [
                  "starting",
                  "running",
                  "succeeded",
                  "failed",
                  "cancelled"
                ],
                "type": "string"
              },
              "timeoutMs": {
                "maximum": 86400000,
                "minimum": 30000,
                "type": "integer"
              },
              "version": {
                "const": 1,
                "type": "number"
              },
              "workspaceId": {
                "minLength": 1,
                "type": "string"
              }
            },
            "required": [
              "version",
              "id",
              "workspaceId",
              "operation",
              "commandHash",
              "command",
              "shell",
              "cwd",
              "state",
              "createdAt",
              "timeoutMs"
            ],
            "type": "object"
          },
          "type": "array"
        }
      },
      "required": [
        "tasks"
      ],
      "type": "object"
    },
    "title": "List background tasks"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Cancels an active background task and terminates its process tree.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "id": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "id"
      ],
      "type": "object"
    },
    "name": "cancel_background_task",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "task": {
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "command": {
                  "maxLength": 32000,
                  "minLength": 1,
                  "type": "string"
                },
                "commandHash": {
                  "pattern": "^[a-f0-9]{64}$",
                  "type": "string"
                },
                "completedAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "createdAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "cwd": {
                  "minLength": 1,
                  "type": "string"
                },
                "error": {
                  "type": "string"
                },
                "id": {
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                  "type": "string"
                },
                "lifecycle": {
                  "additionalProperties": false,
                  "properties": {
                    "deadlineAt": {
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                      "type": "string"
                    },
                    "diagnostic": {
                      "maxLength": 500,
                      "minLength": 1,
                      "type": "string"
                    },
                    "effectiveTimeoutMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "elapsedMs": {
                      "maximum": 9007199254740991,
                      "minimum": 0,
                      "type": "integer"
                    },
                    "reason": {
                      "enum": [
                        "timeout",
                        "cancelled",
                        "client_disconnected",
                        "upstream_timeout",
                        "process_failed"
                      ],
                      "type": "string"
                    },
                    "requestedTimeoutMs": {
                      "exclusiveMinimum": 0,
                      "maximum": 86400000,
                      "type": "integer"
                    },
                    "terminatedBy": {
                      "enum": [
                        "chatgpt_tool",
                        "mcp_server",
                        "gateway",
                        "relay",
                        "workspace_agent",
                        "executor",
                        "child_process",
                        "http_client",
                        "http_server",
                        "websocket",
                        "proxy",
                        "background_task_manager",
                        "external"
                      ],
                      "type": "string"
                    }
                  },
                  "required": [
                    "requestedTimeoutMs",
                    "effectiveTimeoutMs",
                    "deadlineAt",
                    "elapsedMs"
                  ],
                  "type": "object"
                },
                "operation": {
                  "maxLength": 128,
                  "minLength": 1,
                  "type": "string"
                },
                "pid": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "result": {
                  "additionalProperties": false,
                  "properties": {
                    "cwd": {
                      "type": "string"
                    },
                    "exitCode": {
                      "anyOf": [
                        {
                          "maximum": 9007199254740991,
                          "minimum": -9007199254740991,
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "lifecycle": {
                      "additionalProperties": false,
                      "properties": {
                        "deadlineAt": {
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                          "type": "string"
                        },
                        "diagnostic": {
                          "maxLength": 500,
                          "minLength": 1,
                          "type": "string"
                        },
                        "effectiveTimeoutMs": {
                          "maximum": 9007199254740991,
                          "minimum": 0,
                          "type": "integer"
                        },
                        "elapsedMs": {
                          "maximum": 9007199254740991,
                          "minimum": 0,
                          "type": "integer"
                        },
                        "reason": {
                          "enum": [
                            "timeout",
                            "cancelled",
                            "client_disconnected",
                            "upstream_timeout",
                            "process_failed"
                          ],
                          "type": "string"
                        },
                        "requestedTimeoutMs": {
                          "exclusiveMinimum": 0,
                          "maximum": 86400000,
                          "type": "integer"
                        },
                        "terminatedBy": {
                          "enum": [
                            "chatgpt_tool",
                            "mcp_server",
                            "gateway",
                            "relay",
                            "workspace_agent",
                            "executor",
                            "child_process",
                            "http_client",
                            "http_server",
                            "websocket",
                            "proxy",
                            "background_task_manager",
                            "external"
                          ],
                          "type": "string"
                        }
                      },
                      "required": [
                        "requestedTimeoutMs",
                        "effectiveTimeoutMs",
                        "deadlineAt",
                        "elapsedMs"
                      ],
                      "type": "object"
                    },
                    "shell": {
                      "enum": [
                        "powershell",
                        "pwsh",
                        "cmd",
                        "wsl",
                        "git-bash"
                      ],
                      "type": "string"
                    },
                    "status": {
                      "const": "executed",
                      "type": "string"
                    },
                    "stderr": {
                      "type": "string"
                    },
                    "stdout": {
                      "type": "string"
                    },
                    "timedOut": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "status",
                    "shell",
                    "cwd",
                    "exitCode",
                    "stdout",
                    "stderr",
                    "timedOut"
                  ],
                  "type": "object"
                },
                "shell": {
                  "enum": [
                    "powershell",
                    "pwsh",
                    "cmd",
                    "wsl",
                    "git-bash"
                  ],
                  "type": "string"
                },
                "startedAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
                  "type": "string"
                },
                "state": {
                  "enum": [
                    "starting",
                    "running",
                    "succeeded",
                    "failed",
                    "cancelled"
                  ],
                  "type": "string"
                },
                "timeoutMs": {
                  "maximum": 86400000,
                  "minimum": 30000,
                  "type": "integer"
                },
                "version": {
                  "const": 1,
                  "type": "number"
                },
                "workspaceId": {
                  "minLength": 1,
                  "type": "string"
                }
              },
              "required": [
                "version",
                "id",
                "workspaceId",
                "operation",
                "commandHash",
                "command",
                "shell",
                "cwd",
                "state",
                "createdAt",
                "timeoutMs"
              ],
              "type": "object"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "task"
      ],
      "type": "object"
    },
    "title": "Cancel background task"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Reads size-limited, redacted stdout and stderr logs for one background task.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "id": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "maxBytes": {
          "default": 100000,
          "exclusiveMinimum": 0,
          "maximum": 1000000,
          "type": "integer"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "id"
      ],
      "type": "object"
    },
    "name": "read_background_task_logs",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "logs": {
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "id": {
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                  "type": "string"
                },
                "stderr": {
                  "type": "string"
                },
                "stderrBytes": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "stdout": {
                  "type": "string"
                },
                "stdoutBytes": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "truncated": {
                  "type": "boolean"
                }
              },
              "required": [
                "id",
                "stdout",
                "stderr",
                "stdoutBytes",
                "stderrBytes",
                "truncated"
              ],
              "type": "object"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "logs"
      ],
      "type": "object"
    },
    "title": "Read background task logs"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Searches for a literal string within workspace file contents. Use list_files to enumerate paths instead. For aggregate workspaces, never search without a concrete root: if the root is unknown, call list_workspace_roots first; if already known, pass it directly. root=\".\" is equivalent to omitting root. Operational artifact directories (runtime, releases, .runtime-tools) are omitted from implicit discovery; set root explicitly to search them.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "caseSensitive": {
          "default": false,
          "type": "boolean"
        },
        "glob": {
          "minLength": 1,
          "type": "string"
        },
        "query": {
          "minLength": 1,
          "type": "string"
        },
        "root": {
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "query"
      ],
      "type": "object"
    },
    "name": "search_files",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "matches": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "column": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              },
              "line": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              },
              "path": {
                "type": "string"
              },
              "snippet": {
                "type": "string"
              }
            },
            "required": [
              "path",
              "line",
              "column",
              "snippet"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "skippedFiles": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "truncated": {
          "type": "boolean"
        }
      },
      "required": [
        "matches",
        "truncated",
        "skippedFiles"
      ],
      "type": "object"
    },
    "title": "Search files"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Inspects an explicit Git root inside an authorized workspace. Use this for exact branch, status and summary/full diffs; use get_workspace_context instead when the goal is project instructions, discovered skills or lightweight Git worktree hints.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "diffMode": {
          "default": "summary",
          "enum": [
            "none",
            "summary",
            "full"
          ],
          "type": "string"
        },
        "maxDiffBytes": {
          "default": 40000,
          "exclusiveMinimum": 0,
          "maximum": 1000000,
          "type": "integer"
        },
        "paths": {
          "default": [],
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 20,
          "type": "array"
        },
        "root": {
          "default": ".",
          "minLength": 1,
          "type": "string"
        },
        "timeoutMs": {
          "default": 60000,
          "exclusiveMinimum": 0,
          "maximum": 300000,
          "type": "integer"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "type": "object"
    },
    "name": "inspect_workspace_git",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "branch": {
          "minLength": 1,
          "type": "string"
        },
        "diffMode": {
          "enum": [
            "none",
            "summary",
            "full"
          ],
          "type": "string"
        },
        "root": {
          "minLength": 1,
          "type": "string"
        },
        "staged": {
          "type": "string"
        },
        "status": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "indexStatus": {
                "type": "string"
              },
              "originalPath": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "workTreeStatus": {
                "type": "string"
              }
            },
            "required": [
              "path",
              "indexStatus",
              "workTreeStatus"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "truncated": {
          "type": "boolean"
        },
        "unstaged": {
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "root",
        "branch",
        "diffMode",
        "status",
        "staged",
        "unstaged",
        "truncated"
      ],
      "type": "object"
    },
    "title": "Inspect workspace Git"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": true
    },
    "description": "Returns project instruction files (AGENTS.md, CLAUDE.md), discovered skills and lightweight Git worktree hints for a workspace/root. Use this after selecting the workspace and, for aggregates, a concrete root. Use inspect_workspace_git when exact branch/status/diff data is required instead of project context.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "root": {
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "type": "object"
    },
    "name": "get_workspace_context",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "availableInstructionFiles": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "git": {
          "additionalProperties": false,
          "properties": {
            "currentBranch": {
              "type": "string"
            },
            "isDirty": {
              "type": "boolean"
            },
            "isGitRepository": {
              "type": "boolean"
            },
            "suggestedWorktreeRoot": {
              "type": "string"
            }
          },
          "required": [
            "isGitRepository"
          ],
          "type": "object"
        },
        "instructionFiles": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "exists": {
                "const": true,
                "type": "boolean"
              },
              "name": {
                "type": "string"
              },
              "path": {
                "type": "string"
              }
            },
            "required": [
              "name",
              "path",
              "exists"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "rootPath": {
          "type": "string"
        },
        "skills": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "name": {
                "type": "string"
              },
              "skillFilePath": {
                "type": "string"
              },
              "source": {
                "enum": [
                  "project-cursor",
                  "project-pi"
                ],
                "type": "string"
              }
            },
            "required": [
              "name",
              "skillFilePath",
              "source"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "workspaceId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "rootPath",
        "instructionFiles",
        "availableInstructionFiles",
        "skills",
        "git"
      ],
      "type": "object"
    },
    "title": "Get workspace context"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Creates a local Git branch at the exact expected HEAD in an authorized workspace repository.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "branch": {
          "maxLength": 255,
          "minLength": 1,
          "type": "string"
        },
        "expectedHeadSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "branch",
        "expectedHeadSha"
      ],
      "type": "object"
    },
    "name": "git_create_branch",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "branch": {
          "maxLength": 255,
          "minLength": 1,
          "type": "string"
        },
        "headSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "root",
        "branch",
        "headSha"
      ],
      "type": "object"
    },
    "title": "Create Git branch"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Stages an explicit bounded list of workspace-relative Git paths.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "paths": {
          "items": {
            "maxLength": 4096,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 200,
          "minItems": 1,
          "type": "array"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "paths"
      ],
      "type": "object"
    },
    "name": "git_stage_paths",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "headSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "indexTreeSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "paths": {
          "items": {
            "maxLength": 4096,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 200,
          "minItems": 1,
          "type": "array"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "root",
        "headSha",
        "indexTreeSha",
        "paths"
      ],
      "type": "object"
    },
    "title": "Stage Git paths"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Unstages an explicit bounded list of workspace-relative Git paths when HEAD and index preconditions match.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "expectedHeadSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "expectedIndexTreeSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "paths": {
          "items": {
            "maxLength": 4096,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 200,
          "minItems": 1,
          "type": "array"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "paths",
        "expectedHeadSha",
        "expectedIndexTreeSha"
      ],
      "type": "object"
    },
    "name": "git_unstage_paths",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "headSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "indexTreeSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "paths": {
          "items": {
            "maxLength": 4096,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 200,
          "minItems": 1,
          "type": "array"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "root",
        "headSha",
        "indexTreeSha",
        "paths"
      ],
      "type": "object"
    },
    "title": "Unstage Git paths"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Creates one local Git commit when the expected HEAD and index-tree preconditions match.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "expectedHeadSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "expectedIndexTreeSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "message": {
          "maxLength": 4000,
          "minLength": 1,
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "message",
        "expectedHeadSha",
        "expectedIndexTreeSha"
      ],
      "type": "object"
    },
    "name": "git_commit",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "branch": {
          "maxLength": 255,
          "minLength": 1,
          "type": "string"
        },
        "commitSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "root",
        "branch",
        "commitSha"
      ],
      "type": "object"
    },
    "title": "Commit staged Git changes"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Fast-forwards the current local branch to an exact expected source SHA; merge commits and conflict resolution are not supported.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "expectedSourceHeadSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "expectedTargetHeadSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "sourceBranch": {
          "maxLength": 255,
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "sourceBranch",
        "expectedTargetHeadSha",
        "expectedSourceHeadSha"
      ],
      "type": "object"
    },
    "name": "git_merge_branch",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "branch": {
          "maxLength": 255,
          "minLength": 1,
          "type": "string"
        },
        "fastForwarded": {
          "const": true,
          "type": "boolean"
        },
        "headSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "previousHeadSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "sourceHeadSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        }
      },
      "required": [
        "root",
        "branch",
        "previousHeadSha",
        "headSha",
        "sourceHeadSha",
        "fastForwarded"
      ],
      "type": "object"
    },
    "title": "Fast-forward Git branch"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false,
      "readOnlyHint": false
    },
    "description": "Pushes one explicit non-protected branch to a named remote after typed confirmation; ambiguous outcomes require reconciliation.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "branch": {
          "maxLength": 255,
          "minLength": 1,
          "type": "string"
        },
        "confirmationId": {
          "maxLength": 128,
          "minLength": 1,
          "type": "string"
        },
        "expectedLocalSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "expectedRemoteSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "remote": {
          "maxLength": 255,
          "minLength": 1,
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "branch",
        "expectedLocalSha"
      ],
      "type": "object"
    },
    "name": "git_push_branch",
    "title": "Push Git branch"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true,
      "readOnlyHint": true
    },
    "description": "Reads typed metadata for an authorized GitHub repository.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "owner": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "repository": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "owner",
        "repository"
      ],
      "type": "object"
    },
    "name": "github_get_repository",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "defaultBranch": {
          "maxLength": 255,
          "minLength": 1,
          "type": "string"
        },
        "fullName": {
          "maxLength": 201,
          "minLength": 3,
          "type": "string"
        },
        "name": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "owner": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "url": {
          "format": "uri",
          "type": "string"
        },
        "visibility": {
          "enum": [
            "private",
            "public",
            "internal"
          ],
          "type": "string"
        }
      },
      "required": [
        "owner",
        "name",
        "fullName",
        "defaultBranch",
        "visibility",
        "url"
      ],
      "type": "object"
    },
    "title": "Get GitHub repository"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": true,
      "readOnlyHint": false
    },
    "description": "Creates a GitHub repository for an explicitly authorized account owner after typed confirmation.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "confirmationId": {
          "maxLength": 128,
          "minLength": 1,
          "type": "string"
        },
        "description": {
          "maxLength": 350,
          "type": "string"
        },
        "name": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "owner": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "visibility": {
          "enum": [
            "private",
            "public",
            "internal"
          ],
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "owner",
        "name",
        "visibility"
      ],
      "type": "object"
    },
    "name": "github_create_repository",
    "title": "Create GitHub repository"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true,
      "readOnlyHint": true
    },
    "description": "Reads typed metadata for a pull request in an authorized GitHub repository.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "owner": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "pullNumber": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "repository": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "owner",
        "repository",
        "pullNumber"
      ],
      "type": "object"
    },
    "name": "github_get_pull_request",
    "outputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "baseSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "headSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "merged": {
          "type": "boolean"
        },
        "number": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "state": {
          "enum": [
            "open",
            "closed"
          ],
          "type": "string"
        },
        "title": {
          "maxLength": 256,
          "minLength": 1,
          "type": "string"
        },
        "url": {
          "format": "uri",
          "type": "string"
        }
      },
      "required": [
        "number",
        "state",
        "title",
        "url",
        "headSha",
        "baseSha",
        "merged"
      ],
      "type": "object"
    },
    "title": "Get GitHub pull request"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": true,
      "readOnlyHint": false
    },
    "description": "Creates a pull request in an authorized GitHub repository after typed confirmation.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "base": {
          "maxLength": 255,
          "minLength": 1,
          "type": "string"
        },
        "body": {
          "maxLength": 65536,
          "type": "string"
        },
        "confirmationId": {
          "maxLength": 128,
          "minLength": 1,
          "type": "string"
        },
        "draft": {
          "type": "boolean"
        },
        "head": {
          "maxLength": 255,
          "minLength": 1,
          "type": "string"
        },
        "owner": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "repository": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "title": {
          "maxLength": 256,
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "owner",
        "repository",
        "title",
        "head",
        "base"
      ],
      "type": "object"
    },
    "name": "github_create_pull_request",
    "title": "Create GitHub pull request"
  },
  {
    "_meta": {
      "securitySchemes": [
        {
          "scopes": [
            "workspaces:read"
          ],
          "type": "oauth2"
        }
      ]
    },
    "annotations": {
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": true,
      "readOnlyHint": false
    },
    "description": "Merges an authorized pull request at an exact expected head SHA after typed confirmation.",
    "execution": {
      "taskSupport": "forbidden"
    },
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "confirmationId": {
          "maxLength": 128,
          "minLength": 1,
          "type": "string"
        },
        "expectedPullRequestHeadSha": {
          "pattern": "^[a-fA-F0-9]{40}$",
          "type": "string"
        },
        "mergeMethod": {
          "enum": [
            "merge",
            "squash"
          ],
          "type": "string"
        },
        "owner": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "pullNumber": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "repository": {
          "maxLength": 100,
          "minLength": 1,
          "type": "string"
        },
        "root": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "workspaceId": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "owner",
        "repository",
        "pullNumber",
        "expectedPullRequestHeadSha",
        "mergeMethod"
      ],
      "type": "object"
    },
    "name": "github_merge_pull_request",
    "title": "Merge GitHub pull request"
  }
] as const;

export const EDGE_MCP_CATALOG_METADATA = {
  "contractRevision": "27dd48bba413cd810f43840482b9f99b3da4e6aaa0a8d825ab9f1031498a46be",
  "descriptorRevision": "fb7a5c628c5af2cc586988552c284c9feb337f09089d66f8ad7ac1211143492c",
  "serverVersion": "0.4.0-catalog.c27dd48bba413.sed9448dace99",
  "toolCount": 28,
  "toolSetRevision": "ed9448dace99031ebb1c5105de027290fc6decbd4a8b00b9ff1711652493860f"
} as const;

export const EDGE_MCP_SERVER_IDENTITY = {
  "name": "vs-code-gpt",
  "version": "0.4.0-catalog.c27dd48bba413.sed9448dace99"
} as const;
