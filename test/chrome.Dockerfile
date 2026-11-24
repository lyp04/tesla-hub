FROM mcr.microsoft.com/playwright:v1.49.1-noble
# Google Chrome: unlike Playwright's Chromium it has H.264 / AAC, which the canvas player needs
RUN npx -y playwright@1.49.1 install chrome
