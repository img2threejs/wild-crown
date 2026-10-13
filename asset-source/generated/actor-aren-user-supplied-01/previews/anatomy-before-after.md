# Aren clips — anatomy before / after the guard + choreography redesign

Cells are peak `twist/swing` degrees (rest-relative, about the bone axis toward the first child, max over left/right). Deformation = |ln(edge/bind)| over unique triangle edges ≥ 3 mm and all keyframes (p99 / p99.9 / max). Aim = mean/max blade-direction error (degrees) against the authored aim curve. Native supplied clips: max p99.9 = 1.32193.

| clip | state | Head | Neck | Spine* | Arms | ForeArms | Hands | Feet | p99 | p99.9 | max | worst bone | aim mean/max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| aren-light-1 | before | 33/15 | 8/9 | 9/23 | 37/89 | 57/94 | 101/90 | 84/85 | 0.44171 | 0.91047 | 2.47258 | LeftLeg | 8.91/21.91 |
| aren-light-1 | after | 33/11 | 7/23 | 12/14 | 34/89 | 34/99 | 35/75 | 25/50 | 0.3901 | 0.91625 | 2.48639 | RightArm | 0.02/0.1 |
| aren-light-2 | before | 67/12 | 15/27 | 17/16 | 95/93 | 57/105 | 100/56 | 87/44 | 0.43609 | 0.91413 | 3.22131 | RightArm | 8.81/18.19 |
| aren-light-2 | after | 22/26 | 3/7 | 17/27 | 80/73 | 36/83 | 35/71 | 25/50 | 0.41071 | 0.96782 | 2.93599 | LeftUpLeg | 0.06/0.11 |
| aren-light-3 | before | 32/15 | 8/10 | 9/23 | 37/88 | 49/94 | 96/89 | 84/85 | 0.4453 | 0.92332 | 2.54488 | LeftLeg | 8.48/20.87 |
| aren-light-3 | after | 32/15 | 8/10 | 17/24 | 42/88 | 67/94 | 34/71 | 25/50 | 0.39284 | 0.92632 | 2.54488 | LeftLeg | 0.22/0.5 |
| aren-light-4 | before | 21/29 | 3/10 | 14/27 | 135/75 | 15/84 | 109/109 | 101/61 | 0.51792 | 1.07833 | 2.93995 | RightForeArm | 15.93/51.3 |
| aren-light-4 | after | 49/40 | 3/6 | 18/23 | 58/91 | 70/112 | 34/71 | 25/50 | 0.48911 | 1.20208 | 2.98471 | RightUpLeg | 0.21/0.71 |
| aren-sigil-bolt | before | 24/31 | 5/7 | 7/26 | 35/75 | 43/111 | 71/63 | 79/90 | 0.44124 | 0.8944 | 2.81914 | RightLeg | 5.53/12.05 |
| aren-sigil-bolt | after | 24/31 | 5/7 | 7/26 | 36/75 | 66/111 | 33/67 | 25/50 | 0.40565 | 0.89601 | 2.81914 | RightLeg | 0.05/0.19 |
| aren-sigil-barrage | before | 24/26 | 5/8 | 7/26 | 35/75 | 45/113 | 75/63 | 81/89 | 0.43976 | 0.88654 | 2.64256 | RightLeg | 4.34/10.34 |
| aren-sigil-barrage | after | 24/26 | 5/8 | 7/26 | 36/75 | 66/113 | 33/67 | 25/50 | 0.39888 | 0.87554 | 2.64256 | RightLeg | 0.09/0.26 |
| aren-sigil-charge | before | 95/15 | 20/13 | 15/12 | 76/53 | 20/69 | 102/57 | 77/64 | 0.55082 | 1.0164 | 2.69327 | RightFoot | 1.14/2.14 |
| aren-sigil-charge | after | 1/12 | 0/4 | 2/29 | 6/83 | 40/82 | 33/71 | 25/33 | 0.37313 | 0.85842 | 1.61136 | RightArm | 0.07/0.08 |
| aren-judgement | before | 17/32 | 3/7 | 21/20 | 31/64 | 90/97 | 78/95 | 34/31 | 0.4784 | 1.10019 | 3.40553 | LeftUpLeg | 27.16/63.81 |
| aren-judgement | after | 50/31 | 8/7 | 13/18 | 61/72 | 67/109 | 35/72 | 25/47 | 0.46767 | 1.08028 | 2.70317 | LeftUpLeg | 0.09/0.37 |
| aren-heavy | before | 19/30 | 3/11 | 13/27 | 136/76 | 15/84 | 104/121 | 101/61 | 0.5242 | 1.09498 | 2.42858 | Spine | 16.46/59.44 |
| aren-heavy | after | 22/30 | 3/11 | 14/27 | 80/77 | 50/84 | 35/71 | 25/50 | 0.45979 | 1.05454 | 2.92063 | Spine | 0.03/0.21 |
| aren-charged-heavy | before | 20/22 | 10/30 | 12/20 | 65/70 | 102/117 | 109/45 | 27/50 | 0.40783 | 0.94787 | 3.57527 | LeftLeg | 12.7/28.09 |
| aren-charged-heavy | after | 49/40 | 3/6 | 18/23 | 73/93 | 70/112 | 34/46 | 25/50 | 0.48289 | 1.19615 | 3.08861 | RightLeg | 0.13/0.82 |
| aren-charged-heavy-charge | before | 17/8 | 2/4 | 13/14 | 132/35 | 79/83 | 104/65 | 100/41 | 0.52101 | 0.98552 | 2.33027 | RightArm | 12.22/17.52 |
| aren-charged-heavy-charge | after | 35/17 | 8/15 | 1/3 | 21/57 | 19/19 | 33/53 | 25/50 | 0.35301 | 0.80328 | 3.06443 | RightLeg | 0/0.05 |
| aren-root-tether | before | 95/15 | 20/19 | 16/16 | 76/87 | 10/99 | 108/77 | 90/67 | 0.53215 | 1.01116 | 3.38568 | RightUpLeg | 12.6/70.43 |
| aren-root-tether | after | 50/33 | 13/20 | 20/27 | 79/66 | 66/118 | 35/65 | 25/50 | 0.48741 | 1.12772 | 2.98111 | LeftUpLeg | 0.74/9.23 |
| aren-cleanse | before | 95/19 | 20/19 | 16/16 | 76/88 | 8/99 | 107/75 | 91/67 | 0.4858 | 1.00137 | 3.36752 | RightUpLeg | 25.55/72.84 |
| aren-cleanse | after | 31/34 | 7/20 | 7/35 | 69/65 | 67/71 | 35/71 | 25/50 | 0.61255 | 1.23458 | 3.05568 | RightLeg | 0.1/0.36 |
| aren-hit | before | 14/29 | 15/7 | 6/28 | 72/78 | 9/116 | 33/52 | 0/0 | 0.32151 | 0.69081 | 2.32798 | RightArm | - |
| aren-hit | after | 14/29 | 15/7 | 6/28 | 72/78 | 9/116 | 33/52 | 0/0 | 0.31002 | 0.68033 | 2.32798 | RightArm | - |
| aren-stagger | before | 16/28 | 11/9 | 8/31 | 54/74 | 24/103 | 37/96 | 75/78 | 0.45623 | 0.97721 | 3.63523 | RightUpLeg | 15.09/21.18 |
| aren-stagger | after | 16/28 | 11/9 | 8/31 | 54/72 | 42/105 | 33/71 | 25/50 | 0.41699 | 1.00469 | 3.63523 | RightUpLeg | 0.11/0.12 |
| aren-back-handspring | before | 30/31 | 6/19 | 6/25 | 77/76 | 79/66 | 129/95 | 99/45 | 0.46911 | 1.04303 | 3.66956 | RightFoot | 36.02/85.36 |
| aren-back-handspring | after | 30/31 | 6/19 | 6/25 | 76/76 | 67/66 | 35/75 | 25/45 | 0.43981 | 1.00889 | 3.59917 | Hips | 0.22/0.65 |
| aren-air-step | before | (clip did not exist) |
| aren-air-step | after | 29/30 | 5/19 | 12/32 | 77/82 | 68/103 | 35/75 | 25/47 | 0.42001 | 0.99497 | 3.47008 | LeftUpLeg | 0.09/1.03 |
