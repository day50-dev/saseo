// The logo: 사서 ("librarian") on a square of the accent color. The letters are outlines (from Noto
// Sans KR, thickened by a stroke), so they draw the same with or without a Korean font installed.
// public/favicon.svg is the same drawing in fixed colors.
const SA = "M384 218H452V380Q452 455 434 527Q415 599 381 662Q347 725 301 774Q255 823 201 852L150 785Q200 760 242 718Q285 675 317 620Q349 565 366 504Q384 442 384 380ZM399 218H466V380Q466 440 484 499Q501 558 533 610Q565 662 606 703Q648 744 696 768L645 834Q592 807 548 760Q503 713 470 652Q436 592 418 522Q399 453 399 380ZM775 140H858V1045H775ZM839 506H1006V577H839Z";
const SEO = "M1495 447H1746V515H1495ZM1276 218H1344V380Q1344 455 1326 528Q1307 601 1273 664Q1239 727 1194 776Q1148 825 1094 854L1042 787Q1092 763 1134 720Q1177 677 1209 622Q1241 566 1258 504Q1276 443 1276 380ZM1293 218H1360V380Q1360 441 1378 501Q1395 561 1427 614Q1459 666 1502 707Q1544 748 1593 771L1543 838Q1489 810 1443 763Q1397 716 1364 655Q1330 594 1312 524Q1293 454 1293 380ZM1705 140H1787V1046H1705Z";

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 1940 1190" aria-hidden="true" focusable="false">
      <rect width="1940" height="1190" rx="210" fill="var(--accent)" />
      <path d={`${SA}${SEO}`} fill="var(--accent-text)" stroke="var(--accent-text)" strokeWidth="36" strokeLinejoin="round" />
    </svg>
  );
}
