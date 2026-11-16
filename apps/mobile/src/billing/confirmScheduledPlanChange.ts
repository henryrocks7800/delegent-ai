import { Alert } from 'react-native';
import { SCHEDULED_PLAN_CHANGE_CONFIRMATION as copy } from '@sidekick/shared';

export function confirmScheduledPlanChange(): Promise<boolean> {
  return new Promise(resolve => Alert.alert(copy.title, copy.body, [
    { text: copy.cancelLabel, style: 'cancel', onPress: () => resolve(false) },
    { text: copy.confirmLabel, style: 'destructive', onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }));
}
