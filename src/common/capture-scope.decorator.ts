import { SetMetadata } from '@nestjs/common';
import type { CaptureSectionKey } from './capture-scope';

export const CAPTURE_SECTION_KEY = 'captureSection';

// Marks a route as belonging to one capture section, so CaptureScopeGuard can
// refuse it while that section is switched off for the current exercise.
export const CaptureSection = (section: CaptureSectionKey) =>
  SetMetadata(CAPTURE_SECTION_KEY, section);
