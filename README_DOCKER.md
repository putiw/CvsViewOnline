# Deploying CvsView Web on Docker

This project is configured for easy containerized deployment using Docker. The build process uses a multi-stage `Dockerfile` that compiles the React Native Web app into static files and serves them using Nginx.

## Prerequisites
- Docker installed on your machine or VM.
- Docker Compose (optional, but recommended).

## Quick Start (Docker Compose)

> **IMPORTANT**: The MRI sample data is **not** included in the git repository (it is ignored due to size). You must copy your local `assets/sample_data` directory to the server before building:
>
> ```bash
> # From your LOCAL machine:
> scp -r assets/sample_data mri@your-server-ip:~/path/to/CvsViewOnline/assets/
> ```

1.  **Build and Run**:
    ```bash
    docker-compose up -d --build
    ```

2.  **Access the App**:
    Open your browser and navigate to `http://localhost:8080`.

## Manual Docker Commands

1.  **Build the Image**:
    ```bash
    docker build -t cvsview-web .
    ```

2.  **Run the Container**:
    ```bash
    docker run -d -p 8080:80 --name cvsview-container cvsview-web
    ```

## Customization

- **Port Mapping**: To change the exposed port, modify the `ports` section in `docker-compose.yml` (e.g., `"80:80"` for standard HTTP).
- **Environment**: If you need to inject environment variables, add an `env_file` or `environment` section to `docker-compose.yml`.

## Troubleshooting

- If you encounter build errors related to `expo`, ensure your network allows NPM package installation.
- Check container logs: `docker logs cvsview-container`.
