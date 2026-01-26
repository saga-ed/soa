import { v4 as uuidv4 } from 'uuid';
import type { Project } from './project.js';
import type { CreateProjectInput, UpdateProjectInput } from './schema/project.schemas.js';

/**
 * ProjectHelper class encapsulates business logic for Project operations.
 * This class demonstrates the recommended pattern for organizing business logic
 * and can easily be replaced with a real service in production.
 */
export class ProjectHelper {
  // Mock data store - in production, this would be a database connection
  private projects: Project[] = [
    {
      id: '1',
      name: 'Saga SOA Platform',
      description: 'A modular service-oriented architecture platform',
      status: 'active',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: '2',
      name: 'API Gateway',
      description: 'Centralized API management and routing',
      status: 'active',
      createdAt: new Date('2024-01-15'),
      updatedAt: new Date('2024-01-15'),
    },
  ];

  /**
   * Get all projects
   */
  getAllProjects(): Project[] {
    return [...this.projects];
  }

  /**
   * Get project by ID
   */
  getProjectById(id: string): Project | null {
    return this.projects.find(project => project.id === id) || null;
  }

  /**
   * Create a new project
   */
  createProject(input: CreateProjectInput): Project {
    const now = new Date();
    const project: Project = {
      id: uuidv4(),
      name: input.name,
      description: input.description,
      status: input.status,
      createdAt: now,
      updatedAt: now,
    };

    this.projects.push(project);
    return project;
  }

  /**
   * Update an existing project
   */
  updateProject(input: UpdateProjectInput): Project | null {
    const projectIndex = this.projects.findIndex(project => project.id === input.id);
    if (projectIndex === -1) {
      return null;
    }

    const project = this.projects[projectIndex]!;
    const updatedProject: Project = {
      id: project.id,
      name: input.name ?? project.name,
      description: input.description ?? project.description,
      status: input.status ?? project.status,
      createdAt: project.createdAt,
      updatedAt: new Date(),
    };

    this.projects[projectIndex] = updatedProject;
    return updatedProject;
  }

  /**
   * Delete a project
   */
  deleteProject(id: string): boolean {
    const projectIndex = this.projects.findIndex(project => project.id === id);
    if (projectIndex === -1) {
      return false;
    }

    this.projects.splice(projectIndex, 1);
    return true;
  }
}
