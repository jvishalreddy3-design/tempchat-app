import { registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar } from '@capacitor/status-bar';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { io } from 'socket.io-client';

const EkaPermissions = registerPlugin('EkaPermissions');

window.TempChatNative = { native: true, App, Network, SplashScreen, StatusBar, SecureStorage, EkaPermissions };
window.io = io;
