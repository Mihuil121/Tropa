// Иконки из @expo/vector-icons (набор Material Design Icons — тот же, что у react-native-vector-icons).
// react-icons — только для сайтов (рисует через HTML/SVG), в React Native он не работает.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ComponentProps } from 'react';
import type { StyleProp, TextStyle } from 'react-native';

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({ name, size = 22, color = '#1d2129', style }: { name: IconName; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  return <MaterialCommunityIcons name={name} size={size} color={color} style={style} />;
}

/** Иконка манёвра по типу Valhalla. */
export function maneuverIcon(type: number | undefined): IconName {
  switch (type) {
    case 9: case 18: case 20: case 23: return 'arrow-top-right';    // плавно направо, съезд/держаться правее
    case 10: return 'arrow-right';                                   // направо
    case 11: return 'arrow-bottom-right';                            // резко направо
    case 12: return 'arrow-u-left-top';                              // разворот
    case 13: return 'arrow-u-right-top';
    case 14: return 'arrow-bottom-left';                             // резко налево
    case 15: return 'arrow-left';                                    // налево
    case 16: case 19: case 21: case 24: return 'arrow-top-left';     // плавно налево
    case 26: case 27: return 'rotate-right';                         // кольцо
    case 4: case 5: case 6: return 'flag-checkered';                 // приехали
    default: return 'arrow-up';
  }
}
