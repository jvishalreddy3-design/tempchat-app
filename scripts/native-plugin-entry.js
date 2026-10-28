import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar } from '@capacitor/status-bar';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { io } from 'socket.io-client';

window.TempChatNative = { App, Network, SplashScreen, StatusBar, SecureStorage };
window.io = io;
