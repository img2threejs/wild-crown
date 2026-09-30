import './style.css';
import { mountGameApplication } from './app/GameApplication.js';

const root=document.querySelector<HTMLElement>('#app');
if(!root)throw new Error('Application mount #app was not found.');
mountGameApplication(root);
