#!/bin/bash
cd /Users/jaycoai/Projects/tryout-timer
git pull
npm install
npm run build
pm2 restart tryout-timer
echo "Tryout Timer deployed successfully!"
