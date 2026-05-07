.PHONY: install test test-coverage lint lint-fix format format-check build-config build deploy clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies
	npm install

test: ## Run unit tests
	npm test

test-coverage: ## Run tests with coverage report
	npm run test:coverage

lint: ## Lint all source files
	npm run lint

lint-fix: ## Lint and auto-fix
	npm run lint:fix

format: ## Format all files with Prettier
	npm run format

format-check: ## Check formatting without writing
	npm run format:check

build-config: ## Generate Lambda config files from .env
	node scripts/build-config.mjs

build: build-config ## Build SAM application
	sam build

deploy: build ## Build and deploy to AWS (us-east-1)
	sam deploy

clean: ## Remove build artifacts and dependencies
	rm -rf .aws-sam coverage
	rm -rf node_modules src/auth-check/node_modules src/auth-callback/node_modules
